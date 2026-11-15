// Logic tests on the SQLite stand-in (tests/helpers/sqlite-db.ts). They do NOT prove TiDB behaviour: see tests/tidb/slots.test.ts.
import { beforeEach, describe, expect, it } from 'vitest'
import { changeStatus, createAppointment, InvalidAppointmentError, rescheduleAppointment, SlotConflictError, StaleVersionError, sweepStale } from '../src/appointments/slots'
import { sqliteDb } from './helpers/sqlite-db'

const T = Date.parse('2026-11-16T09:00:00Z'), M = 60_000
const w = (o: Partial<{ clinicId: string; dentistId: string; chairId: string; patientId: string }> = {}) => ({ clinicId: 'A', dentistId: 'd1', chairId: 'c1', patientId: 'p1', ...o })
let db: ReturnType<typeof sqliteDb>
beforeEach(() => { db = sqliteDb() })
const count = (t: string) => (db.raw.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as any).n as number
const book = (o = {}, start = T, mins = 30) => createAppointment(db, { ...w(o), startAt: start, endAt: start + mins * M }, T)

describe('create', () => {
  it('claims 3 resources × 5-minute slots and goes live', async () => {
    const id = await book()
    expect(count('appointment_slot')).toBe(6 * 3)
    expect((db.raw.prepare('SELECT live FROM appointment WHERE id=?').get(id) as any).live).toBe(1)
  })
  it.each([['dentist', { patientId: 'p2', chairId: 'c2' }], ['chair', { patientId: 'p2', dentistId: 'd2' }], ['patient', { dentistId: 'd2', chairId: 'c2' }]])('rejects overlap on the same %s', async (_k, other) => {
    await book()
    await expect(book(other, T + 15 * M)).rejects.toBeInstanceOf(SlotConflictError)
  })
  it('a failed booking leaves no claims and no appointment row, and does not disturb the winner', async () => {
    await book()
    await expect(book({ patientId: 'p2', chairId: 'c2' }, T + 10 * M)).rejects.toBeInstanceOf(SlotConflictError)
    expect(count('appointment')).toBe(1); expect(count('appointment_slot')).toBe(18)
  })
  it('back-to-back (half-open) is allowed; other clinics never conflict', async () => {
    await book(); await book({}, T + 30 * M); await book({ clinicId: 'B' })
    expect(count('appointment')).toBe(3)
  })
  it('rejects off-grid times and bad durations instead of moving them', async () => {
    await expect(createAppointment(db, { ...w(), startAt: T + 3 * M, endAt: T + 33 * M }, T)).rejects.toBeInstanceOf(InvalidAppointmentError)
    await expect(book({}, T, 10)).rejects.toBeInstanceOf(InvalidAppointmentError)
    await expect(book({}, T, 481)).rejects.toBeInstanceOf(InvalidAppointmentError)
    expect(count('appointment')).toBe(0)
  })
})

describe('reschedule', () => {
  it('claims only the delta, frees the old-only slots, bumps version', async () => {
    const id = await book()
    await rescheduleAppointment(db, 'A', id, 1, { startAt: T + 15 * M, endAt: T + 45 * M }, T)
    const a = db.raw.prepare('SELECT version v FROM appointment WHERE id=?').get(id) as any
    expect(a.v).toBe(2); expect(count('appointment_slot')).toBe(18)
    await book({ patientId: 'p2', dentistId: 'd2', chairId: 'c2' }, T) // 09:00 is free again for others
  })
  it('conflict leaves the original booking intact', async () => {
    const id = await book(); await book({ patientId: 'p2', chairId: 'c2' }, T + 60 * M) // same dentist d1
    await expect(rescheduleAppointment(db, 'A', id, 1, { startAt: T + 45 * M, endAt: T + 75 * M }, T)).rejects.toBeInstanceOf(SlotConflictError)
    expect(count('appointment_slot')).toBe(18 + 18)
    expect((db.raw.prepare('SELECT start_at s FROM appointment WHERE id=?').get(id) as any).s).toBe('2026-11-16 09:00:00.000')
  })
  it('a stale version loses and reverts its claims', async () => {
    const id = await book()
    await rescheduleAppointment(db, 'A', id, 1, { startAt: T + 60 * M, endAt: T + 90 * M }, T)
    await expect(rescheduleAppointment(db, 'A', id, 1, { startAt: T + 120 * M, endAt: T + 150 * M }, T)).rejects.toBeInstanceOf(StaleVersionError)
    expect(count('appointment_slot')).toBe(18)
  })
  it('only scheduled/confirmed appointments move; other clinics cannot touch it', async () => {
    const id = await book(); await changeStatus(db, 'A', id, 'arrived', null, null, T)
    await expect(rescheduleAppointment(db, 'A', id, 2, { startAt: T + 60 * M, endAt: T + 90 * M }, T)).rejects.toBeInstanceOf(InvalidAppointmentError)
    await expect(rescheduleAppointment(db, 'B', id, 2, { startAt: T + 60 * M, endAt: T + 90 * M }, T)).rejects.toBeInstanceOf(InvalidAppointmentError)
  })
})

describe('status', () => {
  it('cancel frees slots; reinstating re-claims and fails if taken; transitions are enforced', async () => {
    const id = await book()
    await changeStatus(db, 'A', id, 'cancelled', 's1', 'patient called', T)
    expect(count('appointment_slot')).toBe(0)
    const other = await book({ patientId: 'p2' }) // same dentist+chair now free
    await expect(changeStatus(db, 'A', id, 'scheduled', null, null, T)).rejects.toBeInstanceOf(SlotConflictError)
    expect((db.raw.prepare('SELECT status s FROM appointment WHERE id=?').get(id) as any).s).toBe('cancelled')
    expect(count('appointment_slot')).toBe(18) // only the other booking's claims remain
    await expect(changeStatus(db, 'A', other, 'completed', null, null, T)).rejects.toBeInstanceOf(InvalidAppointmentError)
    expect(count('appointment_status_change')).toBe(1)
  })
})

describe('sweep', () => {
  it('removes stuck bookings past the lease but never a live appointment or a fresh in-flight one', async () => {
    const live = await book()
    db.raw.prepare("INSERT INTO appointment (id,clinic_id,patient_id,dentist_id,chair_id,start_at,end_at,status,live,version,created_at,updated_at) VALUES ('stuck','A','p9','d9','c9','x','x','scheduled',0,1,?,?)").run('2026-11-16 08:00:00.000', '2026-11-16 08:00:00.000')
    db.raw.prepare("INSERT INTO appointment_slot VALUES ('A','dentist','d9','2026-11-16 09:00:00.000','stuck','2026-11-16 08:00:00.000')").run()
    db.raw.prepare("INSERT INTO appointment (id,clinic_id,patient_id,dentist_id,chair_id,start_at,end_at,status,live,version,created_at,updated_at) VALUES ('fresh','A','p8','d8','c8','x','x','scheduled',0,1,?,?)").run('2026-11-16 08:59:00.000', '2026-11-16 08:59:00.000')
    db.raw.prepare("INSERT INTO appointment_slot VALUES ('A','dentist','d8','2026-11-16 09:05:00.000','fresh','2026-11-16 08:59:00.000')").run()
    await sweepStale(db, T)
    const ids = (db.raw.prepare('SELECT id FROM appointment ORDER BY id').all() as any[]).map((r) => r.id)
    expect(ids).toEqual([live, 'fresh'].sort())
    expect((db.raw.prepare("SELECT COUNT(*) n FROM appointment_slot WHERE appointment_id='stuck'").get() as any).n).toBe(0)
    expect((db.raw.prepare("SELECT COUNT(*) n FROM appointment_slot WHERE appointment_id IN ('fresh', ?)").get(live) as any).n).toBe(1 + 18)
  })
})
