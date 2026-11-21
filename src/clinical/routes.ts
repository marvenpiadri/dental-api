import { Hono } from 'hono'
import { ApiError, fail } from '../http/errors'
import { authenticate, requires } from '../http/middleware'
import type { AppEnv } from '../http/context'
import type { Db } from '../db/client'
import { decodeCursor, encodeCursor, page, parseLimit } from '../lib/pagination'
import { formatMoney, parseMoney } from '../lib/money'
import { isUuid, newId } from '../lib/ids'
import { toDb } from '../lib/time'
import { applyChanges, initChart, loadChart, parseChanges, restoreTo, validateChart, versionOk, type Scope } from './chart'

export const clinicalRoutes = new Hono<AppEnv>()
clinicalRoutes.use('*', authenticate)
clinicalRoutes.onError((e, c) => { if (e instanceof ApiError) return fail(c, e); throw e })

const bad = (m = 'Invalid request') => new ApiError(400, 'bad_request', m)
const notFound = () => new ApiError(404, 'not_found', 'Not found')
const stale = () => new ApiError(409, 'stale', 'This record changed; reload and try again')
const body = async (c: { req: { json: () => Promise<unknown> } }) => { const b = await c.req.json().catch(() => null); if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad(); return b as Record<string, unknown> }
const str = (v: unknown, max: number, required = false): string | null => { if (v === undefined || v === null || v === '') { if (required) throw bad(); return null } if (typeof v !== 'string' || v.length > max) throw bad(); return v.trim() }
const instant = (v: unknown): number => { if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,3})?)?Z$/.test(v) || !Number.isFinite(Date.parse(v))) throw bad('Times must be UTC ISO strings ending in Z'); return Date.parse(v) }
const version = (v: unknown): number => { if (!Number.isInteger(v) || (v as number) < 0) throw bad('expectedVersion must be an integer'); return v as number }
const ownPatient = async (db: Db, clinicId: string, id: string) => { if (!isUuid(id) || !(await db.rows('SELECT 1 FROM patient WHERE id = $1 AND clinic_id = $2', [id, clinicId])).length) throw notFound() }
const cursorIn = (raw: string | undefined) => { const cur = decodeCursor(raw); if (cur === null || (cur && (!isUuid(cur[1]) || Number.isNaN(Date.parse(cur[0]))))) throw bad('Invalid cursor'); return cur }

// ---- medical history: one row per patient, optimistic version (expectedVersion 0 = first save), every save keeps the previous content ----
clinicalRoutes.get('/patients/:id/medical', requires('clinical.view'), async (c) => {
  const p = c.get('principal'); await ownPatient(c.get('db'), p.clinicId, c.req.param('id'))
  const [r] = await c.get('db').rows('SELECT conditions, allergies, medications, legacy_matched, version, updated_at FROM patient_medical WHERE patient_id = $1 AND clinic_id = $2', [c.req.param('id'), p.clinicId])
  if (!r) return c.json({ conditions: [], allergies: '', medications: '', legacyMatched: [], version: 0 })
  return c.json({ conditions: r.conditions, allergies: r.allergies ?? '', medications: r.medications ?? '', legacyMatched: r.legacy_matched, version: r.version, updatedAt: r.updated_at })
})
const strList = (v: unknown, n: number, max: number): string[] => { if (v === undefined) return []; if (!Array.isArray(v) || v.length > n || v.some((x) => typeof x !== 'string' || x.length > max)) throw bad(); return v as string[] }
clinicalRoutes.put('/patients/:id/medical', requires('clinical.edit'), async (c) => {
  const p = c.get('principal'), b = await body(c), pid = c.req.param('id'), exp = version(b.expectedVersion), t = toDb(c.get('now'))
  const next = { conditions: strList(b.conditions, 100, 100), allergies: str(b.allergies, 2000), medications: str(b.medications, 2000), legacyMatched: strList(b.legacyMatched, 200, 300) }
  const v = await c.get('db').tx(async (db) => {
    await ownPatient(db, p.clinicId, pid)
    const [before] = await db.rows('SELECT conditions, allergies, medications, legacy_matched, version FROM patient_medical WHERE patient_id = $1 FOR UPDATE', [pid])
    if ((before?.version ?? 0) !== exp) throw stale()
    const nv = exp + 1, args = [JSON.stringify(next.conditions), next.allergies, next.medications, JSON.stringify(next.legacyMatched)]
    if (before) await db.run('UPDATE patient_medical SET conditions = $1::jsonb, allergies = $2, medications = $3, legacy_matched = $4::jsonb, version = $5, updated_at = $6, updated_by = $7 WHERE patient_id = $8', [...args, nv, t, p.staffId, pid])
    else await db.run('INSERT INTO patient_medical (conditions, allergies, medications, legacy_matched, version, updated_at, updated_by, patient_id, clinic_id) VALUES ($1::jsonb,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)', [...args, nv, t, p.staffId, pid, p.clinicId])
    await db.run('INSERT INTO medical_revision (id, clinic_id, patient_id, version, before, after, staff_id, at) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)',
      [newId(), p.clinicId, pid, nv, before ? JSON.stringify({ conditions: before.conditions, allergies: before.allergies, medications: before.medications, legacyMatched: before.legacy_matched }) : null, JSON.stringify(next), p.staffId, t])
    return nv
  })
  return c.json({ version: v })
})

// ---- the chart: odontogram and periodontogram live in the same tooth records. No whole-chart overwrite exists. ----
clinicalRoutes.get('/patients/:id/chart', requires('clinical.view'), async (c) => {
  const p = c.get('principal'); await ownPatient(c.get('db'), p.clinicId, c.req.param('id'))
  const r = await loadChart(c.get('db'), p.clinicId, c.req.param('id'))
  return r ? c.json(r) : c.json({ chart: null })
})
clinicalRoutes.post('/patients/:id/chart', requires('clinical.edit'), async (c) => {
  const p = c.get('principal'), b = await body(c), chart = validateChart(b.chart), pid = c.req.param('id')
  await c.get('db').tx(async (db) => { await ownPatient(db, p.clinicId, pid); await initChart(db, { clinicId: p.clinicId, patientId: pid, staffId: p.staffId, now: c.get('now'), reason: str(b.reason, 500) }, chart) })
  return c.json(await loadChart(c.get('db'), p.clinicId, pid), 201)
})
// Targeted, atomic, revision-checked changes: { changes: [{ scope, tooth, expectedRev, set | unset | replace | clear }], reason?, payloadVersion? }
clinicalRoutes.patch('/patients/:id/chart', requires('clinical.edit'), async (c) => {
  const p = c.get('principal'), b = await body(c), pid = c.req.param('id'), changes = parseChanges(b.changes)
  const reason = str(b.reason, 500), pv = b.payloadVersion === undefined ? null : versionOk(b.payloadVersion)
  const r = await c.get('db').tx(async (db) => {
    await ownPatient(db, p.clinicId, pid)
    if (!(await db.rows('SELECT 1 FROM chart_head WHERE patient_id = $1 FOR UPDATE', [pid])).length) throw new ApiError(404, 'no_chart', 'This patient has no chart yet; create it with POST')
    if (pv) await db.run('UPDATE chart_head SET payload_version = $1 WHERE patient_id = $2', [pv, pid])
    return applyChanges(db, { clinicId: p.clinicId, patientId: pid, staffId: p.staffId, now: c.get('now'), reason }, changes)
  })
  return c.json(r)
})
clinicalRoutes.get('/patients/:id/chart/history', requires('clinical.view'), async (c) => {
  const p = c.get('principal'), q = c.req.query(), limit = parseLimit(q.limit, 25, 100); if (limit === null) throw bad('limit must be 1-100')
  const cur = cursorIn(q.cursor); await ownPatient(c.get('db'), p.clinicId, c.req.param('id'))
  if (q.scope !== undefined && !['teeth', 'plan', 'globals', 'case'].includes(q.scope)) throw bad('Invalid scope')
  if (q.tooth !== undefined && !/^\d\d$/.test(q.tooth)) throw bad('Invalid tooth')
  const args: unknown[] = [p.clinicId, c.req.param('id')]; let w = ''
  if (q.scope) { args.push(q.scope); w += ` AND scope = $${args.length}` }
  if (q.tooth) { args.push(q.tooth); w += ` AND tooth = $${args.length}` }
  if (cur) { args.push(cur[0], cur[1]); w += ` AND (at, id) < ($${args.length - 1}::timestamptz, $${args.length}::uuid)` }
  args.push(limit + 1)
  const rows = await c.get('db').rows(`SELECT id, group_id, scope, tooth, rev, op, reason, staff_id, at FROM chart_revision WHERE clinic_id = $1 AND patient_id = $2${w} ORDER BY at DESC, id DESC LIMIT $${args.length}`, args)
  const r = page(rows, limit, (x) => encodeCursor(String(x.at), String(x.id)))
  return c.json({ items: r.items.map((x) => ({ id: x.id, groupId: x.group_id, scope: x.scope, tooth: x.tooth ?? null, rev: x.rev, op: x.op, reason: x.reason ?? null, by: x.staff_id ?? null, at: x.at })), nextCursor: r.nextCursor })
})
clinicalRoutes.get('/patients/:id/chart/revisions/:rid', requires('clinical.view'), async (c) => {
  const p = c.get('principal'), rid = c.req.param('rid'); await ownPatient(c.get('db'), p.clinicId, c.req.param('id')); if (!isUuid(rid)) throw notFound()
  const [x] = await c.get('db').rows('SELECT id, group_id, scope, tooth, rev, op, before, after, reason, staff_id, at FROM chart_revision WHERE id = $1 AND patient_id = $2 AND clinic_id = $3', [rid, c.req.param('id'), p.clinicId])
  if (!x) throw notFound()
  return c.json({ id: x.id, groupId: x.group_id, scope: x.scope, tooth: x.tooth ?? null, rev: x.rev, op: x.op, before: x.before, after: x.after, reason: x.reason ?? null, by: x.staff_id ?? null, at: x.at })
})
// Recovery: put the chart (from an exam) or one part (from a revision) back as it was. Needs a reason and clinical.void; history is kept.
clinicalRoutes.post('/patients/:id/chart/restore', requires('clinical.void'), async (c) => {
  const p = c.get('principal'), b = await body(c), pid = c.req.param('id'), reason = str(b.reason, 500, true)!
  if (reason.length < 3) throw bad('A reason is required')
  const ctx = { clinicId: p.clinicId, patientId: pid, staffId: p.staffId, now: c.get('now'), reason }
  const r = await c.get('db').tx(async (db) => {
    await ownPatient(db, p.clinicId, pid)
    await db.rows('SELECT 1 FROM chart_head WHERE patient_id = $1 FOR UPDATE', [pid])
    if (b.examId !== undefined) {
      if (typeof b.examId !== 'string' || !isUuid(b.examId)) throw bad()
      const [e] = await db.rows<{ chart: unknown }>('SELECT chart FROM exam WHERE id = $1 AND patient_id = $2 AND clinic_id = $3', [b.examId, pid, p.clinicId]); if (!e) throw notFound()
      return restoreTo(db, ctx, validateChart(e.chart))
    }
    if (typeof b.revisionId !== 'string' || !isUuid(b.revisionId)) throw bad('examId or revisionId is required')
    const [x] = await db.rows<{ scope: Scope; tooth: string | null; before: Record<string, unknown> | null }>('SELECT scope, tooth, before FROM chart_revision WHERE id = $1 AND patient_id = $2 AND clinic_id = $3', [b.revisionId, pid, p.clinicId]); if (!x) throw notFound()
    if (!x.before) throw new ApiError(422, 'nothing_to_restore', 'That revision created the record; there is no earlier state')
    return restoreTo(db, ctx, { scope: x.scope, tooth: x.tooth, data: x.before })
  })
  return c.json(r)
})

// ---- examinations: immutable snapshots taken by the server from the stored chart (the client cannot supply one). Void with a reason. ----
clinicalRoutes.post('/patients/:id/exams', requires('clinical.create'), async (c) => {
  const p = c.get('principal'), b = await body(c), pid = c.req.param('id'), dentistId = b.dentistId === undefined || b.dentistId === null ? null : String(b.dentistId)
  if (dentistId && !isUuid(dentistId)) throw bad()
  const id = newId(), now = c.get('now')
  await c.get('db').tx(async (db) => {
    await ownPatient(db, p.clinicId, pid)
    if (dentistId && !(await db.rows('SELECT 1 FROM dentist_profile WHERE id = $1 AND clinic_id = $2', [dentistId, p.clinicId])).length) throw notFound()
    const cur = await loadChart(db, p.clinicId, pid); if (!cur) throw new ApiError(422, 'no_chart', 'Create the chart before recording an examination')
    await db.run('INSERT INTO exam (id, clinic_id, patient_id, at, dentist_id, note, chart, payload_version, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)',
      [id, p.clinicId, pid, toDb(b.at === undefined ? now : instant(b.at)), dentistId, str(b.note, 4000), JSON.stringify(cur.chart), cur.chart.version, p.staffId, toDb(now)])
  })
  return c.json({ id }, 201)
})
clinicalRoutes.get('/patients/:id/exams', requires('clinical.view'), async (c) => {
  const p = c.get('principal'), q = c.req.query(), limit = parseLimit(q.limit, 20, 50); if (limit === null) throw bad('limit must be 1-50')
  const cur = cursorIn(q.cursor); await ownPatient(c.get('db'), p.clinicId, c.req.param('id'))
  const args: unknown[] = [p.clinicId, c.req.param('id')]; let after = ''
  if (cur) { args.push(cur[0], cur[1]); after = 'AND (at, id) < ($3::timestamptz, $4::uuid)' }
  args.push(limit + 1)
  const rows = await c.get('db').rows(`SELECT id, at, dentist_id, note, payload_version, voided_at, void_reason FROM exam WHERE clinic_id = $1 AND patient_id = $2 ${after} ORDER BY at DESC, id DESC LIMIT $${args.length}`, args)
  const r = page(rows, limit, (x) => encodeCursor(String(x.at), String(x.id)))
  return c.json({ items: r.items.map((x) => ({ id: x.id, at: x.at, dentistId: x.dentist_id ?? null, note: x.note ?? null, payloadVersion: x.payload_version, voidedAt: x.voided_at ?? null, voidReason: x.void_reason ?? null })), nextCursor: r.nextCursor })
})
clinicalRoutes.get('/exams/:id', requires('clinical.view'), async (c) => {
  const id = c.req.param('id'); if (!isUuid(id)) throw notFound()
  const [x] = await c.get('db').rows('SELECT id, patient_id, at, dentist_id, note, chart, payload_version, voided_at, void_reason FROM exam WHERE id = $1 AND clinic_id = $2', [id, c.get('principal').clinicId])
  if (!x) throw notFound()
  return c.json({ id: x.id, patientId: x.patient_id, at: x.at, dentistId: x.dentist_id ?? null, note: x.note ?? null, chart: x.chart, payloadVersion: x.payload_version, voidedAt: x.voided_at ?? null, voidReason: x.void_reason ?? null })
})
clinicalRoutes.post('/exams/:id/void', requires('clinical.void'), async (c) => {
  const b = await body(c), id = c.req.param('id'); if (!isUuid(id)) throw notFound()
  const n = await c.get('db').run('UPDATE exam SET voided_at = $1, void_reason = $2 WHERE id = $3 AND clinic_id = $4 AND voided_at IS NULL', [toDb(c.get('now')), str(b.reason, 500, true), id, c.get('principal').clinicId])
  if (n !== 1) throw notFound(); return c.body(null, 204)
})

// ---- treatment plan ----
const TOOTH = /^(?:[1-4][1-8]|[5-8][1-5])$/, SCOPES = ['quadrant', 'upper', 'lower', 'mouth']
const priceIn = (v: unknown): string => { const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : v; if (typeof s !== 'string' || !/^\d{1,10}(\.\d{1,2})?$/.test(s)) throw bad('Invalid price'); return formatMoney(parseMoney(s)) }
const itemView = (r: Record<string, unknown>) => ({ id: r.id, tooth: r.tooth ?? null, scope: r.scope ?? null, quadrant: r.quadrant ?? null, procedure: r.procedure_id, name: r.name ?? null, price: formatMoney(parseMoney(String(r.price))), currency: r.currency, status: r.status,
  date: r.done_date ?? null, doneAt: r.done_at ?? null, appointmentId: r.appointment_id ?? null })
const ITEM = 'id, tooth, scope, quadrant, procedure_id, name, price, currency, status, done_date::text AS done_date, done_at, appointment_id'
const shape = (b: Record<string, unknown>) => {
  const tooth = str(b.tooth, 2), scope = str(b.scope, 10), quadrant = b.quadrant === undefined || b.quadrant === null ? null : b.quadrant
  if (tooth && !TOOTH.test(tooth)) throw bad('Invalid tooth'); if (scope && !SCOPES.includes(scope)) throw bad('Invalid scope')
  if ((quadrant !== null) !== (scope === 'quadrant') || (quadrant !== null && (!Number.isInteger(quadrant) || (quadrant as number) < 1 || (quadrant as number) > 4))) throw bad('quadrant needs scope "quadrant" and a value from 1 to 4')
  return { tooth, scope, quadrant, procedure_id: str(b.procedure, 64, true), name: str(b.name, 200) }
}
clinicalRoutes.get('/patients/:id/plan', requires('clinical.view'), async (c) => {
  const p = c.get('principal'), q = c.req.query(), limit = parseLimit(q.limit); if (limit === null) throw bad('limit must be 1-100')
  const cur = cursorIn(q.cursor); if (q.status !== undefined && q.status !== 'planned' && q.status !== 'done') throw bad('Invalid status')
  await ownPatient(c.get('db'), p.clinicId, c.req.param('id'))
  const args: unknown[] = [p.clinicId, c.req.param('id')]; let w = ''
  if (q.status) { args.push(q.status); w += ` AND status = $${args.length}` }
  if (cur) { args.push(cur[0], cur[1]); w += ` AND (created_at, id) > ($${args.length - 1}::timestamptz, $${args.length}::uuid)` }
  args.push(limit + 1)
  const rows = await c.get('db').rows(`SELECT ${ITEM}, created_at FROM treatment_item WHERE clinic_id = $1 AND patient_id = $2${w} ORDER BY created_at, id LIMIT $${args.length}`, args)
  const r = page(rows, limit, (x) => encodeCursor(String(x.created_at), String(x.id)))
  return c.json({ items: r.items.map(itemView), nextCursor: r.nextCursor })
})
clinicalRoutes.post('/patients/:id/plan', requires('clinical.create'), async (c) => {
  const p = c.get('principal'), b = await body(c), db = c.get('db'), f = shape(b), id = newId()
  await ownPatient(db, p.clinicId, c.req.param('id'))
  const [cl] = await db.rows<{ currency: string }>('SELECT currency FROM clinic WHERE id = $1', [p.clinicId])
  await db.run('INSERT INTO treatment_item (id, clinic_id, patient_id, tooth, scope, quadrant, procedure_id, name, price, currency, status, created_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
    [id, p.clinicId, c.req.param('id'), f.tooth, f.scope, f.quadrant, f.procedure_id, f.name, priceIn(b.price), cl.currency, 'planned', toDb(c.get('now')), p.staffId])
  return c.json({ id }, 201)
})
// Planned items can be edited and removed. Marking done is the clinical record: it freezes the item (the database refuses later changes).
clinicalRoutes.patch('/plan/:id', requires('clinical.edit'), async (c) => {
  const p = c.get('principal'), b = await body(c), db = c.get('db'), id = c.req.param('id'); if (!isUuid(id)) throw notFound()
  const sets: string[] = [], args: unknown[] = [], set = (col: string, v: unknown) => { args.push(v); sets.push(`${col} = $${args.length}`) }
  if (b.status === 'done') {
    const now = c.get('now'), appt = str(b.appointmentId, 64); if (appt && !isUuid(appt)) throw bad()
    if (appt && !(await db.rows('SELECT 1 FROM appointment WHERE id = $1 AND clinic_id = $2', [appt, p.clinicId])).length) throw notFound()
    sets.push("status = 'done'"); set('done_at', toDb(now)); set('done_date', new Date(now).toISOString().slice(0, 10)); set('appointment_id', appt)
  } else if (b.status !== undefined && b.status !== 'planned') throw bad('Invalid status')
  if (b.price !== undefined) set('price', priceIn(b.price))
  if (b.tooth !== undefined) { const t = str(b.tooth, 2); if (t && !TOOTH.test(t)) throw bad('Invalid tooth'); set('tooth', t) }
  if (b.procedure !== undefined) set('procedure_id', str(b.procedure, 64, true))
  if (b.name !== undefined) set('name', str(b.name, 200))
  if (!sets.length) throw bad('nothing to update')
  const [x] = await db.rows<{ status: string }>('SELECT status FROM treatment_item WHERE id = $1 AND clinic_id = $2 FOR UPDATE', [id, p.clinicId])
  if (!x) throw notFound(); if (x.status === 'done') throw new ApiError(409, 'item_done', 'A completed treatment cannot be changed')
  await db.run(`UPDATE treatment_item SET ${sets.join(', ')} WHERE id = $${args.length + 1} AND clinic_id = $${args.length + 2}`, [...args, id, p.clinicId])
  return c.body(null, 204)
})
clinicalRoutes.delete('/plan/:id', requires('clinical.edit'), async (c) => {
  const id = c.req.param('id'); if (!isUuid(id)) throw notFound()
  const n = await c.get('db').run("DELETE FROM treatment_item WHERE id = $1 AND clinic_id = $2 AND status = 'planned'", [id, c.get('principal').clinicId])
  if (n !== 1) throw new ApiError(409, 'item_done', 'Only a planned treatment can be removed, or it does not exist'); return c.body(null, 204)
})
