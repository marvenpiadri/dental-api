import { Hono } from 'hono'
import { ApiError, fail } from '../http/errors'
import { authenticate, requires } from '../http/middleware'
import type { AppEnv } from '../http/context'
import type { Db } from '../db/client'
import { decodeCursor, encodeCursor, page, parseLimit } from '../lib/pagination'
import { formatMoney, parseMoney } from '../lib/money'
import { isUuid, newId } from '../lib/ids'
import { toDb } from '../lib/time'

/** Visit notes (corrections keep the earlier text; voiding keeps the note) and quotes (a newer quote supersedes an unanswered one). */
export const visitRoutes = new Hono<AppEnv>()
visitRoutes.use('*', authenticate)
visitRoutes.onError((e, c) => { if (e instanceof ApiError) return fail(c, e); throw e })
const bad = (m = 'Invalid request') => new ApiError(400, 'bad_request', m)
const notFound = () => new ApiError(404, 'not_found', 'Not found')
const stale = () => new ApiError(409, 'stale', 'This record changed; reload and try again')
const body = async (c: { req: { json: () => Promise<unknown> } }) => { const b = await c.req.json().catch(() => null); if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad(); return b as Record<string, unknown> }
const str = (v: unknown, max: number, required = false): string | null => { if (v === undefined || v === null || v === '') { if (required) throw bad(); return null } if (typeof v !== 'string' || v.length > max) throw bad(); const t = v.trim(); if (!t && required) throw bad(); return t || null }
const patientOk = async (db: Db, clinicId: string, id: string) => { if (!isUuid(id) || !(await db.rows('SELECT 1 FROM patient WHERE id = $1 AND clinic_id = $2', [id, clinicId])).length) throw notFound() }
const uid = (v: unknown) => { const t = str(v, 64); if (t && !isUuid(t)) throw bad(); return t }
const cursor = (raw: string | undefined) => { const cur = decodeCursor(raw); if (cur === null || (cur && (!isUuid(cur[1]) || Number.isNaN(Date.parse(cur[0]))))) throw bad('Invalid cursor'); return cur }
const rxLines = (v: unknown) => {
  if (v === undefined) return []; if (!Array.isArray(v) || v.length > 30) throw bad()
  return v.map((x) => { if (typeof x !== 'object' || x === null) throw bad(); const o = x as Record<string, unknown>; return { drug: str(o.drug, 200, true), dosage: str(o.dosage, 200) ?? '', duration: str(o.duration, 100) ?? '' } })
}
const noteView = (x: Record<string, unknown>) => ({ id: x.id, at: x.at, appointmentId: x.appointment_id ?? undefined, dentistId: x.dentist_id ?? undefined, complaint: x.complaint ?? undefined, findings: x.findings ?? undefined, care: x.care ?? undefined, prescription: x.prescription, version: x.version, voidedAt: x.voided_at ?? undefined, voidReason: x.void_reason ?? undefined })
const NOTE = 'id, at, appointment_id, dentist_id, complaint, findings, care, prescription, version, voided_at, void_reason'

visitRoutes.get('/patients/:id/visits', requires('clinical.view'), async (c) => {
  const p = c.get('principal'), q = c.req.query(), limit = parseLimit(q.limit); if (limit === null) throw bad('limit must be 1-100'); const cur = cursor(q.cursor)
  await patientOk(c.get('db'), p.clinicId, c.req.param('id'))
  const args: unknown[] = [p.clinicId, c.req.param('id')]; let w = ''
  if (cur) { args.push(cur[0], cur[1]); w = ' AND (at, id) < ($3::timestamptz, $4::uuid)' }
  args.push(limit + 1)
  const rows = await c.get('db').rows(`SELECT ${NOTE} FROM visit_note WHERE clinic_id = $1 AND patient_id = $2${w} ORDER BY at DESC, id DESC LIMIT $${args.length}`, args)
  const r = page(rows, limit, (x) => encodeCursor(String(x.at), String(x.id))); return c.json({ items: r.items.map(noteView), nextCursor: r.nextCursor })
})
visitRoutes.get('/visits/:id', requires('clinical.view'), async (c) => {
  const vid = c.req.param('id'); if (!isUuid(vid)) throw notFound(); const p = c.get('principal')
  const [n] = await c.get('db').rows(`SELECT ${NOTE}, patient_id FROM visit_note WHERE id = $1 AND clinic_id = $2`, [vid, p.clinicId]); if (!n) throw notFound()
  const revs = await c.get('db').rows('SELECT at, complaint, findings, care, prescription FROM visit_note_revision WHERE note_id = $1 ORDER BY version LIMIT 100', [vid])
  return c.json({ ...noteView(n), patientId: n.patient_id, revisions: revs.map((r) => ({ at: r.at, complaint: r.complaint ?? undefined, findings: r.findings ?? undefined, care: r.care ?? undefined, prescription: r.prescription })) })
})
visitRoutes.post('/patients/:id/visits', requires('clinical.create'), async (c) => {
  const p = c.get('principal'), b = await body(c), pid = c.req.param('id'), i = newId()
  const f = { complaint: str(b.complaint, 4000), findings: str(b.findings, 4000), care: str(b.care, 4000), rx: rxLines(b.prescription), appt: uid(b.appointmentId), dentist: uid(b.dentistId) }
  if (!f.complaint && !f.findings && !f.care && !f.rx.length) throw bad('A visit note needs some content')
  await c.get('db').tx(async (db) => {
    await patientOk(db, p.clinicId, pid)
    if (f.appt && !(await db.rows('SELECT 1 FROM appointment WHERE id = $1 AND clinic_id = $2 AND patient_id = $3', [f.appt, p.clinicId, pid])).length) throw notFound()
    if (f.dentist && !(await db.rows('SELECT 1 FROM dentist_profile WHERE id = $1 AND clinic_id = $2', [f.dentist, p.clinicId])).length) throw notFound()
    await db.run('INSERT INTO visit_note (id, clinic_id, patient_id, appointment_id, dentist_id, complaint, findings, care, prescription, at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)', [i, p.clinicId, pid, f.appt, f.dentist, f.complaint, f.findings, f.care, JSON.stringify(f.rx), toDb(c.get('now')), p.staffId])
  })
  return c.json({ id: i }, 201)
})
// Edit = correction: the previous text goes to the revision list in the same transaction.
visitRoutes.put('/visits/:id', requires('clinical.edit'), async (c) => {
  const p = c.get('principal'), b = await body(c), vid = c.req.param('id'); if (!isUuid(vid)) throw notFound()
  if (!Number.isInteger(b.expectedVersion)) throw bad('expectedVersion must be an integer')
  const f = { complaint: str(b.complaint, 4000), findings: str(b.findings, 4000), care: str(b.care, 4000), rx: rxLines(b.prescription) }
  if (!f.complaint && !f.findings && !f.care && !f.rx.length) throw bad('A visit note needs some content')
  const v = await c.get('db').tx(async (db) => {
    const [o] = await db.rows<{ version: number; complaint: string | null; findings: string | null; care: string | null; prescription: unknown; voided_at: string | null }>('SELECT version, complaint, findings, care, prescription, voided_at FROM visit_note WHERE id = $1 AND clinic_id = $2 FOR UPDATE', [vid, p.clinicId])
    if (!o) throw notFound(); if (o.voided_at) throw new ApiError(409, 'voided', 'A voided note cannot be edited'); if (o.version !== b.expectedVersion) throw stale()
    await db.run('INSERT INTO visit_note_revision (id, clinic_id, note_id, version, complaint, findings, care, prescription, at, staff_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)', [newId(), p.clinicId, vid, o.version, o.complaint, o.findings, o.care, JSON.stringify(o.prescription), toDb(c.get('now')), p.staffId])
    await db.run('UPDATE visit_note SET complaint = $1, findings = $2, care = $3, prescription = $4::jsonb, version = version + 1 WHERE id = $5', [f.complaint, f.findings, f.care, JSON.stringify(f.rx), vid])
    return o.version + 1
  })
  return c.json({ version: v })
})
visitRoutes.post('/visits/:id/void', requires('clinical.void'), async (c) => {
  const b = await body(c), vid = c.req.param('id'); if (!isUuid(vid)) throw notFound()
  if ((await c.get('db').run('UPDATE visit_note SET voided_at = $1, void_reason = $2 WHERE id = $3 AND clinic_id = $4 AND voided_at IS NULL', [toDb(c.get('now')), str(b.reason, 500, true), vid, c.get('principal').clinicId])) !== 1) throw notFound(); return c.body(null, 204)
})

// ---- quotes ----
const propView = (x: Record<string, unknown>) => ({ id: x.id, version: x.version, at: x.at, lines: x.lines, total: Number(x.total), status: x.status, decidedAt: x.decided_at ?? undefined })
visitRoutes.get('/patients/:id/proposals', requires('patients.view'), async (c) => {
  const p = c.get('principal'), q = c.req.query(), limit = parseLimit(q.limit, 20, 50); if (limit === null) throw bad('limit must be 1-50')
  await patientOk(c.get('db'), p.clinicId, c.req.param('id'))
  const before = q.before === undefined ? null : Number(q.before); if (before !== null && (!Number.isInteger(before) || before < 1)) throw bad('Invalid before')
  const rows = await c.get('db').rows('SELECT id, version, at, lines, total, status, decided_at FROM plan_proposal WHERE clinic_id = $1 AND patient_id = $2 AND ($3::int IS NULL OR version < $3) ORDER BY version DESC LIMIT $4', [p.clinicId, c.req.param('id'), before, limit + 1])
  return c.json({ items: rows.slice(0, limit).map(propView), nextBefore: rows.length > limit ? rows[limit - 1].version : null })
})
visitRoutes.post('/patients/:id/proposals', requires('patients.edit'), async (c) => {
  const p = c.get('principal'), b = await body(c), pid = c.req.param('id'), i = newId()
  if (!Array.isArray(b.lines) || b.lines.length < 1 || b.lines.length > 60) throw bad('A quote needs 1-60 lines')
  let total = 0n
  const lines = b.lines.map((x: unknown) => {
    if (typeof x !== 'object' || x === null) throw bad(); const o = x as Record<string, unknown>
    const raw = typeof o.price === 'number' && Number.isFinite(o.price) ? String(o.price) : o.price; if (typeof raw !== 'string' || !/^\d{1,10}(\.\d{1,2})?$/.test(raw)) throw bad('Invalid price')
    const t = str(o.tooth, 2); if (t && !/^(?:[1-4][1-8]|[5-8][1-5])$/.test(t)) throw bad('Invalid tooth')
    const m = parseMoney(raw); total += m; return { ...(t ? { tooth: t } : {}), name: str(o.name, 200, true), price: Number(formatMoney(m)) }
  })
  const v = await c.get('db').tx(async (db) => {
    await patientOk(db, p.clinicId, pid)
    await db.rows('SELECT 1 FROM patient WHERE id = $1 FOR UPDATE', [pid]) // serialises quotes per patient so versions are gap-free and one is open at a time
    const [m] = await db.rows<{ v: number | null }>('SELECT max(version) v FROM plan_proposal WHERE patient_id = $1', [pid]), version = (m.v ?? 0) + 1
    await db.run("UPDATE plan_proposal SET status = 'superseded' WHERE patient_id = $1 AND clinic_id = $2 AND status = 'proposed'", [pid, p.clinicId])
    await db.run('INSERT INTO plan_proposal (id, clinic_id, patient_id, version, lines, total, at, created_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)', [i, p.clinicId, pid, version, JSON.stringify(lines), formatMoney(total), toDb(c.get('now')), p.staffId])
    return version
  })
  return c.json({ id: i, version: v }, 201)
})
visitRoutes.post('/proposals/:id/decide', requires('patients.edit'), async (c) => {
  const b = await body(c), pid = c.req.param('id'); if (!isUuid(pid)) throw notFound(); if (b.status !== 'accepted' && b.status !== 'declined') throw bad('status must be accepted or declined')
  const n = await c.get('db').run("UPDATE plan_proposal SET status = $1, decided_at = $2 WHERE id = $3 AND clinic_id = $4 AND status = 'proposed'", [b.status, toDb(c.get('now')), pid, c.get('principal').clinicId])
  if (n !== 1) throw new ApiError(409, 'not_open', 'Only the open quote can be answered'); return c.body(null, 204)
})
