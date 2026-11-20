import { Hono } from 'hono'
import { ApiError, fail } from '../http/errors'
import { authenticate, requires } from '../http/middleware'
import type { AppEnv } from '../http/context'
import { changeStatus, createAppointment, InvalidAppointmentError, rescheduleAppointment, SlotConflictError, StaleVersionError } from './slots'
import { decodeCursor, encodeCursor, page, parseLimit } from '../lib/pagination'
import { fromDb, toDb } from '../lib/time'

export const appointmentRoutes = new Hono<AppEnv>()
appointmentRoutes.use('*', authenticate)

const MAX_RANGE_MS = 62 * 86_400_000
const bad = (m = 'Invalid request') => new ApiError(400, 'bad_request', m)
/** UTC instants only ("...Z"); the clinic's local time is a display concern in the frontend. */
const instant = (v: unknown): number => {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,3})?)?Z$/.test(v)) throw bad('Times must be UTC ISO strings ending in Z')
  const t = Date.parse(v); if (!Number.isFinite(t)) throw bad('Invalid time'); return t
}
const str = (v: unknown, max = 64): string => { if (typeof v !== 'string' || !v || v.length > max) throw bad(); return v }
const json = async (c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> => {
  const b = await c.req.json().catch(() => null); if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad(); return b as Record<string, unknown>
}
const mapError = (e: unknown): never => {
  if (e instanceof SlotConflictError) throw new ApiError(409, 'slot_taken', 'That time is no longer free for the dentist, chair or patient')
  if (e instanceof StaleVersionError) throw new ApiError(409, 'stale', 'The appointment changed; reload and try again')
  if (e instanceof InvalidAppointmentError) throw new ApiError(422, 'invalid_appointment', e.message)
  throw e
}
const out = (r: Record<string, unknown>) => ({ id: r.id, patientId: r.patient_id, dentistId: r.dentist_id, chairId: r.chair_id,
  startAt: new Date(fromDb(String(r.start_at))).toISOString(), endAt: new Date(fromDb(String(r.end_at))).toISOString(), status: r.status, version: r.version, notes: r.notes })

appointmentRoutes.onError((e, c) => {
  if (e instanceof ApiError) return fail(c, e)
  throw e // app.onError logs it and returns a generic 503
})

// Calendar read: a date range is mandatory (no unbounded reads), keyset-paginated by (start_at, id).
appointmentRoutes.get('/', requires('appointments.view'), async (c) => {
  const q = c.req.query(), from = instant(q.from), to = instant(q.to)
  if (to <= from || to - from > MAX_RANGE_MS) throw bad('Range must be positive and at most 62 days')
  const limit = parseLimit(q.limit); if (limit === null) throw bad('limit must be 1-100')
  const cur = decodeCursor(q.cursor); if (cur === null) throw bad('Invalid cursor')
  const p: unknown[] = [c.get('principal').clinicId, toDb(from), toDb(to)]
  let after = ''
  if (cur) { after = 'AND (start_at > ? OR (start_at = ? AND id > ?))'; p.push(cur[0], cur[0], cur[1]) }
  p.push(limit + 1)
  const rows = await c.get('db').rows(`SELECT id, patient_id, dentist_id, chair_id, start_at, end_at, status, version, notes FROM appointment
    WHERE clinic_id = ? AND live = 1 AND start_at >= ? AND start_at < ? ${after} ORDER BY start_at, id LIMIT ?`, p)
  const r = page(rows, limit, (x) => encodeCursor(String(x.start_at), String(x.id)))
  return c.json({ items: r.items.map(out), nextCursor: r.nextCursor })
})

/** Every referenced row must belong to the caller's clinic: ids from the browser are never trusted. */
async function ownsAll(c: { get: (k: 'db') => import('../db/client').Db }, clinicId: string, ids: { patientId: string; dentistId: string; chairId: string }) {
  const db = c.get('db')
  const has = async (t: string, id: string) => (await db.rows(`SELECT id FROM ${t} WHERE id = ? AND clinic_id = ?`, [id, clinicId])).length === 1
  if (!(await has('patient', ids.patientId)) || !(await has('dentist_profile', ids.dentistId)) || !(await has('chair', ids.chairId))) throw new ApiError(404, 'not_found', 'Not found')
}

appointmentRoutes.post('/', requires('appointments.create'), async (c) => {
  const b = await json(c), p = c.get('principal')
  const ids = { patientId: str(b.patientId), dentistId: str(b.dentistId), chairId: str(b.chairId) }
  const startAt = instant(b.startAt), endAt = instant(b.endAt)
  const notes = b.notes === undefined || b.notes === null ? null : str(b.notes, 2000)
  await ownsAll(c, p.clinicId, ids)
  try {
    const id = await createAppointment(c.get('db'), { clinicId: p.clinicId, ...ids, startAt, endAt, status: b.status === undefined ? undefined : str(b.status, 16), notes }, c.get('now'))
    return c.json({ id }, 201)
  } catch (e) { return mapError(e) }
})

appointmentRoutes.post('/:id/reschedule', requires('appointments.edit'), async (c) => {
  const b = await json(c), p = c.get('principal')
  if (!Number.isInteger(b.version)) throw bad()
  const dentistId = b.dentistId === undefined ? undefined : str(b.dentistId), chairId = b.chairId === undefined ? undefined : str(b.chairId)
  const db = c.get('db')
  if (dentistId && !(await db.rows('SELECT id FROM dentist_profile WHERE id = ? AND clinic_id = ?', [dentistId, p.clinicId])).length) throw new ApiError(404, 'not_found', 'Not found')
  if (chairId && !(await db.rows('SELECT id FROM chair WHERE id = ? AND clinic_id = ?', [chairId, p.clinicId])).length) throw new ApiError(404, 'not_found', 'Not found')
  try {
    await rescheduleAppointment(db, p.clinicId, c.req.param('id'), b.version as number, { startAt: instant(b.startAt), endAt: instant(b.endAt), dentistId, chairId }, c.get('now'))
    return c.body(null, 204)
  } catch (e) { return mapError(e) }
})

appointmentRoutes.post('/:id/status', requires('appointments.edit'), async (c) => {
  const b = await json(c), p = c.get('principal')
  const reason = b.reason === undefined || b.reason === null ? null : str(b.reason, 500)
  try {
    await changeStatus(c.get('db'), p.clinicId, c.req.param('id'), str(b.status, 16), p.staffId, reason, c.get('now'))
    return c.body(null, 204)
  } catch (e) { return mapError(e) }
})
