import { Hono } from 'hono'
import { ApiError, fail } from '../http/errors'
import { authenticate, requires } from '../http/middleware'
import type { AppEnv } from '../http/context'
import { ExclusionError, type Db } from '../db/client'
import { decodeCursor, encodeCursor, page, parseLimit } from '../lib/pagination'
import { isUuid, newId } from '../lib/ids'
import { toDb } from '../lib/time'
import { appointmentCols, appointmentOut } from './shape'

export const appointmentRoutes = new Hono<AppEnv>()
appointmentRoutes.use('*', authenticate)
appointmentRoutes.onError((e, c) => {
  if (e instanceof ApiError) return fail(c, e)
  // The database's EXCLUDE constraints are the double-booking arbiter; whichever request loses gets this.
  if (e instanceof ExclusionError) return fail(c, new ApiError(409, 'slot_taken', 'That time is no longer free for the dentist, chair or patient'))
  throw e
})

const GRID_MS = 5 * 60_000, MIN_MIN = 15, MAX_MIN = 480, MAX_RANGE_MS = 62 * 86_400_000
const ACTIVE = ['scheduled', 'confirmed', 'arrived', 'in-progress', 'completed']
const MOVABLE = ['scheduled', 'confirmed']
const TRANSITIONS: Record<string, readonly string[]> = {
  scheduled: ['confirmed', 'arrived', 'cancelled', 'no-show'], confirmed: ['arrived', 'cancelled', 'no-show'],
  arrived: ['in-progress', 'cancelled'], 'in-progress': ['completed'], cancelled: ['scheduled'], 'no-show': ['scheduled'], completed: [],
}
const bad = (m = 'Invalid request') => new ApiError(400, 'bad_request', m)
const notFound = () => new ApiError(404, 'not_found', 'Not found')
const invalid = (m: string) => new ApiError(422, 'invalid_appointment', m)
/** UTC instants only ("...Z"); the clinic's local time is a display concern in the frontend. */
const instant = (v: unknown): number => {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,3})?)?Z$/.test(v)) throw bad('Times must be UTC ISO strings ending in Z')
  const t = Date.parse(v); if (!Number.isFinite(t)) throw bad('Invalid time'); return t
}
const uuid = (v: unknown): string => { if (typeof v !== 'string' || !isUuid(v)) throw bad(); return v }
const opt = (v: unknown, max: number): string | null => { if (v === undefined || v === null || v === '') return null; if (typeof v !== 'string' || v.length > max) throw bad(); return v }
const json = async (c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> => {
  const b = await c.req.json().catch(() => null); if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad(); return b as Record<string, unknown>
}
/** Off-grid or out-of-range times are rejected, never silently moved. */
const checkTimes = (s: number, e: number) => {
  if (s % GRID_MS || e % GRID_MS) throw invalid('times must be on the 5-minute grid')
  const m = (e - s) / 60_000; if (m < MIN_MIN || m > MAX_MIN) throw invalid('duration must be 15 to 480 minutes')
}
const COLS = appointmentCols, out = appointmentOut

// Calendar read: a date range is mandatory (no unbounded reads), keyset-paginated by (start_at, id).
appointmentRoutes.get('/', requires('appointments.view'), async (c) => {
  const q = c.req.query(), from = instant(q.from), to = instant(q.to)
  if (to <= from || to - from > MAX_RANGE_MS) throw bad('Range must be positive and at most 62 days')
  const limit = parseLimit(q.limit); if (limit === null) throw bad('limit must be 1-100')
  const cur = decodeCursor(q.cursor); if (cur === null) throw bad('Invalid cursor')
  if (cur && (!isUuid(cur[1]) || Number.isNaN(Date.parse(cur[0])))) throw bad('Invalid cursor')
  const p: unknown[] = [c.get('principal').clinicId, toDb(from), toDb(to)]
  let after = ''
  if (cur) { after = 'AND (start_at, id) > ($4::timestamptz, $5::uuid)'; p.push(cur[0], cur[1]) }
  p.push(limit + 1)
  const rows = await c.get('db').rows(`SELECT ${COLS} FROM appointment WHERE clinic_id = $1 AND start_at >= $2 AND start_at < $3 ${after} ORDER BY start_at, id LIMIT $${p.length}`, p)
  const r = page(rows, limit, (x) => encodeCursor(String(x.start_at), String(x.id)))
  return c.json({ items: r.items.map(out), nextCursor: r.nextCursor })
})

/** Ids from the browser are never trusted: every referenced row must belong to the caller's clinic. */
async function ownsAll(db: Db, clinicId: string, patientId: string | null, dentistId: string | null, chairId: string | null) {
  const [r] = await db.rows<{ ok: boolean }>(`SELECT (($2::uuid IS NULL OR EXISTS (SELECT 1 FROM patient WHERE id = $2 AND clinic_id = $1))
    AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM dentist_profile WHERE id = $3 AND clinic_id = $1 AND archived_at IS NULL))
    AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM chair WHERE id = $4 AND clinic_id = $1 AND archived_at IS NULL))) AS ok`, [clinicId, patientId, dentistId, chairId])
  if (!r.ok) throw notFound()
}

appointmentRoutes.post('/', requires('appointments.create'), async (c) => {
  const b = await json(c), p = c.get('principal'), now = c.get('now')
  const patientId = uuid(b.patientId), dentistId = uuid(b.dentistId), chairId = uuid(b.chairId), s = instant(b.startAt), e = instant(b.endAt)
  checkTimes(s, e)
  const status = b.status === undefined ? 'scheduled' : String(b.status)
  if (!['scheduled', 'confirmed', 'arrived'].includes(status)) throw invalid('a new appointment starts as scheduled, confirmed or arrived')
  const id = newId()
  await c.get('db').tx(async (db) => {
    await ownsAll(db, p.clinicId, patientId, dentistId, chairId)
    await db.run(`INSERT INTO appointment (id, clinic_id, patient_id, dentist_id, chair_id, type, status, start_at, end_at, reason, note, created_at, created_by, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $12)`,
      [id, p.clinicId, patientId, dentistId, chairId, opt(b.type, 32) ?? 'consultation', status, toDb(s), toDb(e), opt(b.reason, 500), opt(b.note, 2000), toDb(now), p.staffId])
    await db.run('INSERT INTO appointment_status_change (id, clinic_id, appointment_id, from_status, to_status, staff_id, at) VALUES ($1, $2, $3, NULL, $4, $5, $6)', [newId(), p.clinicId, id, status, p.staffId, toDb(now)])
  })
  return c.json({ id }, 201)
})

type Loaded = { id: string; patient_id: string; dentist_id: string; chair_id: string; start_at: string; end_at: string; status: string; version: number }
const lockOne = async (db: Db, clinicId: string, id: string): Promise<Loaded> => {
  if (!isUuid(id)) throw notFound()
  const [a] = await db.rows<Loaded>('SELECT id, patient_id, dentist_id, chair_id, start_at, end_at, status, version FROM appointment WHERE id = $1 AND clinic_id = $2 FOR UPDATE', [id, clinicId])
  if (!a) throw notFound(); return a
}
const stale = () => new ApiError(409, 'stale', 'The appointment changed; reload and try again')

appointmentRoutes.post('/:id/reschedule', requires('appointments.edit'), async (c) => {
  const b = await json(c), p = c.get('principal'), now = c.get('now')
  if (!Number.isInteger(b.version)) throw bad()
  const s = instant(b.startAt), e = instant(b.endAt); checkTimes(s, e)
  const dentistId = b.dentistId === undefined ? null : uuid(b.dentistId), chairId = b.chairId === undefined ? null : uuid(b.chairId)
  const version = await c.get('db').tx(async (db) => {
    const a = await lockOne(db, p.clinicId, c.req.param('id'))
    if (!MOVABLE.includes(a.status)) throw invalid('only scheduled or confirmed appointments can be moved')
    if (a.version !== b.version) throw stale()
    await ownsAll(db, p.clinicId, null, dentistId, chairId)
    const d = dentistId ?? a.dentist_id, ch = chairId ?? a.chair_id
    await db.run('UPDATE appointment SET start_at = $1, end_at = $2, dentist_id = $3, chair_id = $4, version = version + 1, updated_at = $5 WHERE id = $6', [toDb(s), toDb(e), d, ch, toDb(now), a.id])
    await db.run(`INSERT INTO appointment_schedule_change (id, clinic_id, appointment_id, from_start, to_start, from_dentist_id, to_dentist_id, from_chair_id, to_chair_id, staff_id, at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [newId(), p.clinicId, a.id, a.start_at, toDb(s), a.dentist_id, d, a.chair_id, ch, p.staffId, toDb(now)])
    return a.version + 1
  })
  return c.json({ version })
})

// Edits that are not a move: visit type, reason, note, and (while still movable) which patient it is for. Needs the current version.
appointmentRoutes.patch('/:id', requires('appointments.edit'), async (c) => {
  const b = await json(c), p = c.get('principal'), now = c.get('now')
  if (!Number.isInteger(b.version)) throw bad()
  for (const k of Object.keys(b)) if (!['version', 'type', 'reason', 'note', 'patientId'].includes(k)) throw bad(`Unknown field "${k}"`)
  const sets: string[] = [], vals: unknown[] = []
  const put = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`) }
  if (b.type !== undefined) put('type', opt(b.type, 32) ?? 'consultation')
  if (b.reason !== undefined) put('reason', opt(b.reason, 500))
  if (b.note !== undefined) put('note', opt(b.note, 2000))
  const patientId = b.patientId === undefined ? null : uuid(b.patientId)
  if (!sets.length && !patientId) throw bad('nothing to update')
  const version = await c.get('db').tx(async (db) => {
    const a = await lockOne(db, p.clinicId, c.req.param('id'))
    if (a.version !== b.version) throw stale()
    if (patientId && patientId !== a.patient_id) {
      if (!MOVABLE.includes(a.status)) throw invalid('the patient can only change while the appointment is scheduled or confirmed')
      await ownsAll(db, p.clinicId, patientId, null, null); put('patient_id', patientId)
    }
    vals.push(toDb(now)); sets.push(`updated_at = $${vals.length}`)
    vals.push(a.id)
    await db.run(`UPDATE appointment SET ${sets.join(', ')}, version = version + 1 WHERE id = $${vals.length}`, vals)
    return a.version + 1
  })
  return c.json({ version })
})

appointmentRoutes.post('/:id/status', requires('appointments.edit'), async (c) => {
  const b = await json(c), p = c.get('principal'), now = c.get('now'), to = typeof b.status === 'string' ? b.status : ''
  const reason = opt(b.reason, 500), version = b.version === undefined ? null : Number.isInteger(b.version) ? (b.version as number) : (() => { throw bad() })()
  const next = await c.get('db').tx(async (db) => {
    const a = await lockOne(db, p.clinicId, c.req.param('id'))
    if (version !== null && a.version !== version) throw stale()
    if (!TRANSITIONS[a.status]?.includes(to)) throw invalid(`cannot go from ${a.status} to ${to}`)
    // Reinstating a cancelled/no-show appointment makes it active again; the EXCLUDE constraint refuses it if someone took the time (409 slot_taken).
    await db.run('UPDATE appointment SET status = $1, version = version + 1, updated_at = $2 WHERE id = $3', [to, toDb(now), a.id])
    await db.run('INSERT INTO appointment_status_change (id, clinic_id, appointment_id, from_status, to_status, staff_id, reason, at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [newId(), p.clinicId, a.id, a.status, to, p.staffId, reason, toDb(now)])
    return a.version + 1
  })
  return c.json({ version: next })
})

// Status and reschedule history of one appointment, on demand (kept out of the calendar list).
appointmentRoutes.get('/:id/history', requires('appointments.view'), async (c) => {
  const id = c.req.param('id'), clinicId = c.get('principal').clinicId; if (!isUuid(id)) throw notFound()
  const db = c.get('db')
  if (!(await db.rows('SELECT 1 FROM appointment WHERE id = $1 AND clinic_id = $2', [id, clinicId])).length) throw notFound()
  const status = await db.rows('SELECT from_status AS "from", to_status AS "to", staff_id AS by, reason, at FROM appointment_status_change WHERE appointment_id = $1 ORDER BY at, id LIMIT 200', [id])
  const schedule = await db.rows('SELECT from_start AS "fromStart", to_start AS "toStart", from_dentist_id AS "fromDentistId", to_dentist_id AS "toDentistId", from_chair_id AS "fromChairId", to_chair_id AS "toChairId", staff_id AS by, at FROM appointment_schedule_change WHERE appointment_id = $1 ORDER BY at, id LIMIT 200', [id])
  return c.json({ status, schedule })
})
