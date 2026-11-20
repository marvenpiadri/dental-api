import { Hono } from 'hono'
import { ApiError } from '../http/errors'
import { authenticate, requires } from '../http/middleware'
import type { AppEnv } from '../http/context'
import { DuplicateKeyError, type Db } from '../db/client'
import { decodeCursor, encodeCursor, page, parseLimit } from '../lib/pagination'
import { formatMoney, parseMoney } from '../lib/money'
import { newId } from '../lib/ids'
import { fromDb, toDb } from '../lib/time'
import { ChartError, validateChart } from './chart'

export const clinicalRoutes = new Hono<AppEnv>()
clinicalRoutes.use('*', authenticate)
clinicalRoutes.onError((e, c) => {
  const x = e instanceof ChartError ? new ApiError(422, 'bad_chart', e.message) : e
  if (x instanceof ApiError) return c.json({ error: { code: x.code, message: x.message }, requestId: c.get('requestId') }, x.status)
  throw e
})
const bad = (m = 'Invalid request') => new ApiError(400, 'bad_request', m)
const notFound = () => new ApiError(404, 'not_found', 'Not found')
const stale = () => new ApiError(409, 'stale', 'This record changed; reload and try again')
const body = async (c: { req: { json: () => Promise<unknown> } }) => { const b = await c.req.json().catch(() => null); if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad(); return b as Record<string, unknown> }
const str = (v: unknown, max: number, required = false): string | null => { if (v === undefined || v === null || v === '') { if (required) throw bad(); return null } if (typeof v !== 'string' || v.length > max) throw bad(); return v.trim() }
const parseJson = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) // TiDB's driver returns parsed JSON; the SQLite stand-in returns text
const iso = (s: unknown) => (s ? new Date(fromDb(String(s))).toISOString() : null)
const instant = (v: unknown): number => { if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,3})?)?Z$/.test(v) || !Number.isFinite(Date.parse(v))) throw bad('Times must be UTC ISO strings ending in Z'); return Date.parse(v) }
const version = (v: unknown): number => { if (!Number.isInteger(v) || (v as number) < 0) throw bad('expectedVersion must be an integer'); return v as number }

async function ownPatient(c: { get: (k: 'db') => Db; get2?: never }, clinicId: string, id: string) {
  if (!(await c.get('db').rows('SELECT id FROM patient WHERE id = ? AND clinic_id = ?', [id, clinicId])).length) throw notFound()
}

// ---- medical history: one row per patient, replaced with an optimistic version (expectedVersion 0 = first save) ----
clinicalRoutes.get('/patients/:id/medical', requires('clinical.view'), async (c) => {
  const p = c.get('principal'); await ownPatient(c, p.clinicId, c.req.param('id'))
  const [r] = await c.get('db').rows('SELECT conditions, allergies, medications, legacy_matched, version, updated_at FROM patient_medical WHERE patient_id = ? AND clinic_id = ?', [c.req.param('id'), p.clinicId])
  if (!r) return c.json({ conditions: [], allergies: '', medications: '', legacyMatched: [], version: 0 })
  return c.json({ conditions: parseJson(r.conditions) ?? [], allergies: r.allergies ?? '', medications: r.medications ?? '', legacyMatched: parseJson(r.legacy_matched) ?? [], version: r.version, updatedAt: iso(r.updated_at) })
})
const strList = (v: unknown, n: number, max: number): string[] => { if (v === undefined) return []; if (!Array.isArray(v) || v.length > n || v.some((x) => typeof x !== 'string' || x.length > max)) throw bad(); return v as string[] }
clinicalRoutes.put('/patients/:id/medical', requires('clinical.edit'), async (c) => {
  const p = c.get('principal'), b = await body(c), db = c.get('db'), pid = c.req.param('id'), exp = version(b.expectedVersion)
  await ownPatient(c, p.clinicId, pid)
  const vals = [JSON.stringify(strList(b.conditions, 100, 100)), str(b.allergies, 2000), str(b.medications, 2000), JSON.stringify(strList(b.legacyMatched, 200, 300))]
  const t = toDb(c.get('now'))
  if (exp === 0) {
    try { await db.run('INSERT INTO patient_medical (patient_id, clinic_id, conditions, allergies, medications, legacy_matched, version, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)', [pid, p.clinicId, ...vals, t, p.staffId]) }
    catch (e) { if (e instanceof DuplicateKeyError) throw stale(); throw e }
  } else if ((await db.run('UPDATE patient_medical SET conditions = ?, allergies = ?, medications = ?, legacy_matched = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE patient_id = ? AND clinic_id = ? AND version = ?', [...vals, t, p.staffId, pid, p.clinicId, exp])) !== 1) throw stale()
  return c.json({ version: exp + 1 })
})

// ---- the patient's working chart (odontogram / periodontogram payload), optimistic version ----
clinicalRoutes.get('/patients/:id/chart', requires('clinical.view'), async (c) => {
  const p = c.get('principal'); await ownPatient(c, p.clinicId, c.req.param('id'))
  const [r] = await c.get('db').rows('SELECT chart, payload_version, version, updated_at FROM patient_chart WHERE patient_id = ? AND clinic_id = ?', [c.req.param('id'), p.clinicId])
  return r ? c.json({ chart: parseJson(r.chart), payloadVersion: r.payload_version, version: r.version, updatedAt: iso(r.updated_at) }) : c.json({ chart: null, version: 0 })
})
clinicalRoutes.put('/patients/:id/chart', requires('clinical.edit'), async (c) => {
  const p = c.get('principal'), b = await body(c), db = c.get('db'), pid = c.req.param('id'), exp = version(b.expectedVersion)
  const ch = validateChart(b.chart); await ownPatient(c, p.clinicId, pid)
  const t = toDb(c.get('now'))
  if (exp === 0) {
    try { await db.run('INSERT INTO patient_chart (patient_id, clinic_id, chart, payload_version, version, updated_at, updated_by) VALUES (?, ?, ?, ?, 1, ?, ?)', [pid, p.clinicId, ch.json, ch.version, t, p.staffId]) }
    catch (e) { if (e instanceof DuplicateKeyError) throw stale(); throw e }
  } else if ((await db.run('UPDATE patient_chart SET chart = ?, payload_version = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE patient_id = ? AND clinic_id = ? AND version = ?', [ch.json, ch.version, t, p.staffId, pid, p.clinicId, exp])) !== 1) throw stale()
  return c.json({ version: exp + 1 })
})

// ---- examinations: append-only snapshots; void with a reason, never edit or delete. Lists never carry chart bodies. ----
clinicalRoutes.post('/patients/:id/exams', requires('clinical.create'), async (c) => {
  const p = c.get('principal'), b = await body(c), db = c.get('db'), pid = c.req.param('id')
  const ch = validateChart(b.chart); await ownPatient(c, p.clinicId, pid)
  const dentistId = str(b.dentistId, 64)
  if (dentistId && !(await db.rows('SELECT id FROM dentist_profile WHERE id = ? AND clinic_id = ?', [dentistId, p.clinicId])).length) throw notFound()
  const id = newId(), now = c.get('now')
  await db.run('INSERT INTO exam (id, clinic_id, patient_id, at, dentist_id, note, chart, payload_version, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, p.clinicId, pid, toDb(b.at === undefined ? now : instant(b.at)), dentistId, str(b.note, 4000), ch.json, ch.version, p.staffId, toDb(now)])
  return c.json({ id }, 201)
})
clinicalRoutes.get('/patients/:id/exams', requires('clinical.view'), async (c) => {
  const p = c.get('principal'), q = c.req.query(), limit = parseLimit(q.limit, 20, 50); if (limit === null) throw bad('limit must be 1-50')
  const cur = decodeCursor(q.cursor); if (cur === null) throw bad('Invalid cursor')
  await ownPatient(c, p.clinicId, c.req.param('id'))
  const args: unknown[] = [p.clinicId, c.req.param('id')]; let after = ''
  if (cur) { after = 'AND (at < ? OR (at = ? AND id < ?))'; args.push(cur[0], cur[0], cur[1]) }
  args.push(limit + 1)
  const rows = await c.get('db').rows(`SELECT id, at, dentist_id, note, payload_version, voided_at, void_reason FROM exam WHERE clinic_id = ? AND patient_id = ? ${after} ORDER BY at DESC, id DESC LIMIT ?`, args)
  const r = page(rows, limit, (x) => encodeCursor(String(x.at), String(x.id)))
  return c.json({ items: r.items.map((x) => ({ id: x.id, at: iso(x.at), dentistId: x.dentist_id ?? null, note: x.note ?? null, payloadVersion: x.payload_version, voidedAt: iso(x.voided_at), voidReason: x.void_reason ?? null })), nextCursor: r.nextCursor })
})
clinicalRoutes.get('/exams/:id', requires('clinical.view'), async (c) => {
  const [x] = await c.get('db').rows('SELECT id, patient_id, at, dentist_id, note, chart, payload_version, voided_at, void_reason FROM exam WHERE id = ? AND clinic_id = ?', [c.req.param('id'), c.get('principal').clinicId])
  if (!x) throw notFound()
  return c.json({ id: x.id, patientId: x.patient_id, at: iso(x.at), dentistId: x.dentist_id ?? null, note: x.note ?? null, chart: parseJson(x.chart), payloadVersion: x.payload_version, voidedAt: iso(x.voided_at), voidReason: x.void_reason ?? null })
})
clinicalRoutes.post('/exams/:id/void', requires('clinical.void'), async (c) => {
  const b = await body(c), n = await c.get('db').run('UPDATE exam SET voided_at = ?, void_reason = ? WHERE id = ? AND clinic_id = ? AND voided_at IS NULL', [toDb(c.get('now')), str(b.reason, 500, true), c.req.param('id'), c.get('principal').clinicId])
  if (n !== 1) throw notFound(); return c.body(null, 204)
})

// ---- treatment plan ----
const TOOTH = /^(?:[1-4][1-8]|[5-8][1-5])$/, SCOPES = ['quadrant', 'upper', 'lower', 'mouth']
const priceIn = (v: unknown): string => { const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : v; if (typeof s !== 'string' || !/^\d{1,10}(\.\d{1,2})?$/.test(s)) throw bad('Invalid price'); return formatMoney(parseMoney(s)) }
const itemView = (r: Record<string, unknown>) => ({ id: r.id, tooth: r.tooth ?? null, scope: r.scope ?? null, quadrant: r.quadrant ?? null, procedure: r.procedure_id, name: r.name ?? null, price: formatMoney(parseMoney(String(r.price))), currency: r.currency, status: r.status,
  date: r.done_date ? String(r.done_date).slice(0, 10) : null, doneAt: iso(r.done_at), appointmentId: r.appointment_id ?? null })
const ITEM = 'id, tooth, scope, quadrant, procedure_id, name, price, currency, status, done_date, done_at, appointment_id'
const shape = (b: Record<string, unknown>) => {
  const tooth = str(b.tooth, 2), scope = str(b.scope, 10), quadrant = b.quadrant === undefined || b.quadrant === null ? null : b.quadrant
  if (tooth && !TOOTH.test(tooth)) throw bad('Invalid tooth'); if (scope && !SCOPES.includes(scope)) throw bad('Invalid scope')
  if (quadrant !== null && (!Number.isInteger(quadrant) || (quadrant as number) < 1 || (quadrant as number) > 4 || scope !== 'quadrant')) throw bad('quadrant needs scope "quadrant" and a value from 1 to 4')
  return { tooth, scope, quadrant, procedure_id: str(b.procedure, 64, true), name: str(b.name, 200) }
}
clinicalRoutes.get('/patients/:id/plan', requires('clinical.view'), async (c) => {
  const p = c.get('principal'), q = c.req.query(), limit = parseLimit(q.limit); if (limit === null) throw bad('limit must be 1-100')
  const cur = decodeCursor(q.cursor); if (cur === null) throw bad('Invalid cursor'); if (q.status !== undefined && q.status !== 'planned' && q.status !== 'done') throw bad('Invalid status')
  await ownPatient(c, p.clinicId, c.req.param('id'))
  const args: unknown[] = [p.clinicId, c.req.param('id')]; let w = ''
  if (q.status) { w += ' AND status = ?'; args.push(q.status) }
  if (cur) { w += ' AND (created_at > ? OR (created_at = ? AND id > ?))'; args.push(cur[0], cur[0], cur[1]) }
  args.push(limit + 1)
  const rows = await c.get('db').rows(`SELECT ${ITEM}, created_at FROM treatment_item WHERE clinic_id = ? AND patient_id = ?${w} ORDER BY created_at, id LIMIT ?`, args)
  const r = page(rows, limit, (x) => encodeCursor(String(x.created_at), String(x.id)))
  return c.json({ items: r.items.map(itemView), nextCursor: r.nextCursor })
})
clinicalRoutes.post('/patients/:id/plan', requires('clinical.create'), async (c) => {
  const p = c.get('principal'), b = await body(c), db = c.get('db'), f = shape(b), id = newId()
  await ownPatient(c, p.clinicId, c.req.param('id'))
  const [cl] = await db.rows<{ currency: string }>('SELECT currency FROM clinic WHERE id = ?', [p.clinicId])
  await db.run('INSERT INTO treatment_item (id, clinic_id, patient_id, tooth, scope, quadrant, procedure_id, name, price, currency, status, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, p.clinicId, c.req.param('id'), f.tooth, f.scope, f.quadrant, f.procedure_id, f.name, priceIn(b.price), cl.currency, 'planned', toDb(c.get('now')), p.staffId])
  return c.json({ id }, 201)
})
// Planned items can be edited and removed. Marking done is the clinical record: it freezes the item (no edits, no removal).
clinicalRoutes.patch('/plan/:id', requires('clinical.edit'), async (c) => {
  const p = c.get('principal'), b = await body(c), db = c.get('db')
  const sets: string[] = [], args: unknown[] = []
  if (b.status === 'done') { sets.push("status = 'done'", 'done_at = ?', 'done_date = ?', 'appointment_id = ?'); const now = c.get('now'); args.push(toDb(now), new Date(now).toISOString().slice(0, 10), str(b.appointmentId, 64)) }
  else if (b.status !== undefined && b.status !== 'planned') throw bad('Invalid status')
  if (b.price !== undefined) { sets.push('price = ?'); args.push(priceIn(b.price)) }
  // Scope/quadrant are not changed in place (remove and re-add the item); only these fields are patchable while planned.
  if (b.tooth !== undefined) { const t = str(b.tooth, 2); if (t && !TOOTH.test(t)) throw bad('Invalid tooth'); sets.push('tooth = ?'); args.push(t) }
  if (b.procedure !== undefined) { sets.push('procedure_id = ?'); args.push(str(b.procedure, 64, true)) }
  if (b.name !== undefined) { sets.push('name = ?'); args.push(str(b.name, 200)) }
  if (!sets.length) throw bad('nothing to update')
  // A done item is the clinical record: only a still-planned item can change (the status guard is part of the UPDATE, so it cannot race).
  const n = await db.run(`UPDATE treatment_item SET ${sets.join(', ')} WHERE id = ? AND clinic_id = ? AND status = 'planned'`, [...args, c.req.param('id'), p.clinicId])
  if (n !== 1) { const [x] = await db.rows('SELECT status FROM treatment_item WHERE id = ? AND clinic_id = ?', [c.req.param('id'), p.clinicId]); throw x ? new ApiError(409, 'item_done', 'A completed treatment cannot be changed') : notFound() }
  return c.body(null, 204)
})
clinicalRoutes.delete('/plan/:id', requires('clinical.edit'), async (c) => {
  const n = await c.get('db').run("DELETE FROM treatment_item WHERE id = ? AND clinic_id = ? AND status = 'planned'", [c.req.param('id'), c.get('principal').clinicId])
  if (n !== 1) throw new ApiError(409, 'item_done', 'Only a planned treatment can be removed, or it does not exist'); return c.body(null, 204)
})
