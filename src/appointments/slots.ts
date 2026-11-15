import { DuplicateKeyError, type Db } from '../db/client'
import { newId } from '../lib/ids'
import { fromDb, toDb } from '../lib/time'

/**
 * Double-booking guard without interactive transactions (docs/architecture.md §4, corrected in §13).
 * Every active appointment claims each 5-minute slot of its dentist, chair AND patient; the slot table's primary key rejects a second claim.
 * Create:  appointment row (live=0) -> claim slots -> verify claim count -> live=1.  Any failure removes only THIS appointment's claims and row.
 * Move:    claim only the delta slots -> version-checked UPDATE (the arbiter) -> delete old-only slots by exact key.
 * A crash can leave extra claims (over-blocking, the safe direction); sweepStale() removes them. It never touches a live appointment's claims.
 * UNVERIFIED on TiDB: multi-row INSERT atomicity and duplicate-key behaviour. tests/tidb/slots.test.ts must pass on a real cluster first.
 */
export const GRID_MS = 5 * 60_000
export const MIN_MINUTES = 15, MAX_MINUTES = 480
export const ACTIVE = ['scheduled', 'confirmed', 'arrived', 'in-progress', 'completed'] as const
export const MOVABLE = ['scheduled', 'confirmed'] as const
export const TRANSITIONS: Record<string, readonly string[]> = {
  scheduled: ['confirmed', 'arrived', 'cancelled', 'no-show'], confirmed: ['arrived', 'cancelled', 'no-show'],
  arrived: ['in-progress', 'cancelled'], 'in-progress': ['completed'], cancelled: ['scheduled'], 'no-show': ['scheduled'], completed: [],
}
const isActive = (s: string) => (ACTIVE as readonly string[]).includes(s)

export class SlotConflictError extends Error { constructor() { super('slot conflict') } }
export class StaleVersionError extends Error { constructor() { super('stale version') } }
export class InvalidAppointmentError extends Error {}

export type Who = { clinicId: string; dentistId: string; chairId: string; patientId: string }
type Key = { kind: 'dentist' | 'chair' | 'patient'; resource: string; slot: string }

/** Off-grid or out-of-range times are rejected, never silently moved. */
export function slotKeys(w: Who, startMs: number, endMs: number): Key[] {
  const mins = (endMs - startMs) / 60_000
  if (!Number.isFinite(startMs) || startMs % GRID_MS || endMs % GRID_MS) throw new InvalidAppointmentError('times must be on the 5-minute grid')
  if (mins < MIN_MINUTES || mins > MAX_MINUTES) throw new InvalidAppointmentError('duration must be 15 to 480 minutes')
  const out: Key[] = []
  for (let t = startMs; t < endMs; t += GRID_MS) for (const [kind, resource] of [['dentist', w.dentistId], ['chair', w.chairId], ['patient', w.patientId]] as const) out.push({ kind, resource, slot: toDb(t) })
  return out
}
const id = (k: Key) => `${k.kind}|${k.resource}|${k.slot}`
const keyWhere = (n: number) => Array(n).fill('(resource_kind = ? AND resource_id = ? AND slot_start = ?)').join(' OR ')
const keyParams = (ks: Key[]) => ks.flatMap((k) => [k.kind, k.resource, k.slot])

async function claim(db: Db, clinicId: string, apptId: string, ks: Key[], now: number): Promise<void> {
  if (!ks.length) return
  try {
    await db.run(`INSERT INTO appointment_slot (clinic_id, resource_kind, resource_id, slot_start, appointment_id, claimed_at) VALUES ${Array(ks.length).fill('(?, ?, ?, ?, ?, ?)').join(', ')}`,
      ks.flatMap((k) => [clinicId, k.kind, k.resource, k.slot, apptId, toDb(now)]))
  } catch (e) { await release(db, clinicId, apptId, ks); throw e instanceof DuplicateKeyError ? new SlotConflictError() : e }
}
/** Deletes only this appointment's claims for the exact keys (a conflicting claim belongs to someone else and is never touched). */
async function release(db: Db, clinicId: string, apptId: string, ks: Key[]): Promise<void> {
  if (ks.length) await db.run(`DELETE FROM appointment_slot WHERE clinic_id = ? AND appointment_id = ? AND (${keyWhere(ks.length)})`, [clinicId, apptId, ...keyParams(ks)])
}
const claimCount = async (db: Db, clinicId: string, apptId: string) =>
  Number((await db.rows<{ n: unknown }>('SELECT COUNT(*) AS n FROM appointment_slot WHERE clinic_id = ? AND appointment_id = ?', [clinicId, apptId]))[0]?.n ?? 0)

export type NewAppointment = Who & { startAt: number; endAt: number; status?: string; notes?: string | null }

export async function createAppointment(db: Db, input: NewAppointment, now: number): Promise<string> {
  const status = input.status ?? 'scheduled'
  if (!isActive(status)) throw new InvalidAppointmentError('new appointments must be in an active status')
  const ks = slotKeys(input, input.startAt, input.endAt)
  const apptId = newId(), t = toDb(now)
  await db.run('INSERT INTO appointment (id, clinic_id, patient_id, dentist_id, chair_id, start_at, end_at, status, live, version, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)',
    [apptId, input.clinicId, input.patientId, input.dentistId, input.chairId, toDb(input.startAt), toDb(input.endAt), status, input.notes ?? null, t, t])
  const undo = async () => { await release(db, input.clinicId, apptId, ks); await db.run('DELETE FROM appointment WHERE id = ? AND clinic_id = ? AND live = 0', [apptId, input.clinicId]) }
  try {
    await claim(db, input.clinicId, apptId, ks, now)
    if ((await claimCount(db, input.clinicId, apptId)) !== ks.length) throw new Error('claim count mismatch')
    if ((await db.run('UPDATE appointment SET live = 1 WHERE id = ? AND clinic_id = ? AND live = 0', [apptId, input.clinicId])) !== 1) throw new Error('could not activate appointment')
  } catch (e) { await undo().catch(() => undefined); throw e }
  return apptId
}

type Appt = { id: string; patient_id: string; dentist_id: string; chair_id: string; start_at: string; end_at: string; status: string; version: number }
const load = async (db: Db, clinicId: string, apptId: string) =>
  (await db.rows<Appt>('SELECT id, patient_id, dentist_id, chair_id, start_at, end_at, status, version FROM appointment WHERE id = ? AND clinic_id = ? AND live = 1', [apptId, clinicId]))[0]
const keysOf = (clinicId: string, a: Appt) => slotKeys({ clinicId, dentistId: a.dentist_id, chairId: a.chair_id, patientId: a.patient_id }, fromDb(a.start_at), fromDb(a.end_at))

export async function rescheduleAppointment(db: Db, clinicId: string, apptId: string, expectedVersion: number,
  to: { startAt: number; endAt: number; dentistId?: string; chairId?: string }, now: number): Promise<void> {
  const a = await load(db, clinicId, apptId)
  if (!a) throw new InvalidAppointmentError('appointment not found')
  if (!(MOVABLE as readonly string[]).includes(a.status)) throw new InvalidAppointmentError('only scheduled or confirmed appointments can be moved')
  if (a.version !== expectedVersion) throw new StaleVersionError()
  const oldK = keysOf(clinicId, a), dentistId = to.dentistId ?? a.dentist_id, chairId = to.chairId ?? a.chair_id
  const newK = slotKeys({ clinicId, dentistId, chairId, patientId: a.patient_id }, to.startAt, to.endAt)
  const oldIds = new Set(oldK.map(id)), newIds = new Set(newK.map(id))
  const added = newK.filter((k) => !oldIds.has(id(k))), removed = oldK.filter((k) => !newIds.has(id(k)))
  await claim(db, clinicId, apptId, added, now) // throws SlotConflictError after releasing its own partial claims
  const changed = await db.run('UPDATE appointment SET start_at = ?, end_at = ?, dentist_id = ?, chair_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND clinic_id = ? AND version = ? AND live = 1',
    [toDb(to.startAt), toDb(to.endAt), dentistId, chairId, toDb(now), apptId, clinicId, expectedVersion])
  if (changed !== 1) { await release(db, clinicId, apptId, added); throw new StaleVersionError() }
  await release(db, clinicId, apptId, removed)
  if ((await claimCount(db, clinicId, apptId)) !== newK.length) console.error('slot claims differ from appointment after move', apptId) // sweepStale/reconcile repairs; over-blocking is the safe direction
}

/** Status change. Leaving the active set frees the slots; reinstating (cancelled/no-show -> scheduled) re-claims them and fails if someone took them. */
export async function changeStatus(db: Db, clinicId: string, apptId: string, to: string, staffId: string | null, reason: string | null, now: number): Promise<void> {
  const a = await load(db, clinicId, apptId)
  if (!a) throw new InvalidAppointmentError('appointment not found')
  if (!TRANSITIONS[a.status]?.includes(to)) throw new InvalidAppointmentError(`cannot go from ${a.status} to ${to}`)
  const ks = keysOf(clinicId, a)
  if (!isActive(a.status) && isActive(to)) await claim(db, clinicId, apptId, ks, now)
  const changed = await db.run('UPDATE appointment SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND clinic_id = ? AND version = ? AND live = 1', [to, toDb(now), apptId, clinicId, a.version])
  if (changed !== 1) { if (!isActive(a.status) && isActive(to)) await release(db, clinicId, apptId, ks); throw new StaleVersionError() }
  if (isActive(a.status) && !isActive(to)) await release(db, clinicId, apptId, ks)
  await db.run('INSERT INTO appointment_status_change (id, clinic_id, appointment_id, from_status, to_status, staff_id, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [newId(), clinicId, apptId, a.status, to, staffId, reason, toDb(now)])
}

/** Removes (1) bookings stuck at live=0 past the lease, with their claims, and (2) claims whose appointment row does not exist, past the lease. Live appointments are never touched. */
export async function sweepStale(db: Db, now: number, leaseMs = 5 * 60_000): Promise<void> {
  const cutoff = toDb(now - leaseMs)
  await db.run('DELETE FROM appointment_slot WHERE claimed_at < ? AND appointment_id IN (SELECT id FROM appointment WHERE live = 0 AND created_at < ?)', [cutoff, cutoff])
  await db.run('DELETE FROM appointment WHERE live = 0 AND created_at < ? AND id NOT IN (SELECT appointment_id FROM appointment_slot)', [cutoff])
  await db.run('DELETE FROM appointment_slot WHERE claimed_at < ? AND appointment_id NOT IN (SELECT id FROM appointment)', [cutoff])
}
