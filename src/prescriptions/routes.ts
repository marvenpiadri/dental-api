import { Hono } from 'hono'
import { ApiError, fail } from '../http/errors'
import { authenticate, requires } from '../http/middleware'
import type { AppEnv } from '../http/context'
import type { Db } from '../db/client'
import { decodeCursor, encodeCursor, page, parseLimit } from '../lib/pagination'
import { isUuid, newId } from '../lib/ids'
import { toDb } from '../lib/time'
import { nextSeq } from '../lib/numbering'
import { yearIn } from '../billing/service'

export const prescriptionRoutes = new Hono<AppEnv>()
prescriptionRoutes.use('*', authenticate)
prescriptionRoutes.onError((e, c) => { if (e instanceof ApiError) return fail(c, e); throw e })
const bad = (m = 'Invalid request') => new ApiError(400, 'bad_request', m)
const notFound = () => new ApiError(404, 'not_found', 'Not found')
const conflict = (m: string) => new ApiError(409, 'conflict', m)
const body = async (c: { req: { json: () => Promise<unknown> } }) => { const b = await c.req.json().catch(() => null); if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad(); return b as Record<string, unknown> }
const parseJson = (v: unknown) => v
const iso = (s: unknown) => (s ? String(s) : null)
const opt = (v: unknown, max: number): string | null => { if (v === undefined || v === null || v === '') return null; if (typeof v !== 'string' || v.length > max) throw bad(); return v.trim() || null }
const reasonOf = (b: Record<string, unknown>) => { const r = opt(b.reason, 500); if (!r) throw bad('A reason is required'); return r }

// ---- items: whitelisted fields only, bounded, ids assigned by the server. The dentist writes doses; nothing here suggests or checks them. ----
const TEXT = ['name', 'brand', 'generic', 'strength', 'form', 'route', 'dosage', 'frequency', 'duration', 'quantity', 'refills'] as const
export function cleanItems(v: unknown, forIssue: boolean): Record<string, unknown>[] {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length > 30) throw bad('At most 30 medications')
  if (forIssue && !v.length) throw bad('Add at least one medication')
  return v.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad()
    const r = raw as Record<string, unknown>, o: Record<string, unknown> = { id: typeof r.id === 'string' && r.id.length <= 64 && r.id ? r.id : newId() }
    for (const k of TEXT) { const t = opt(r[k], 200); if (t) o[k] = t }
    for (const k of ['instructions', 'internalNotes'] as const) { const t = opt(r[k], 1000); if (t) o[k] = t }
    const med = opt(r.medicationId, 64); if (med) o.medicationId = med
    if (r.reviewConditions !== undefined) { if (!Array.isArray(r.reviewConditions) || r.reviewConditions.length > 20 || r.reviewConditions.some((x) => typeof x !== 'string' || x.length > 64)) throw bad(); o.reviewConditions = r.reviewConditions }
    if (r.alerts !== undefined) { if (!Array.isArray(r.alerts) || r.alerts.length > 20 || JSON.stringify(r.alerts).length > 4000) throw bad(); o.alerts = r.alerts }
    if (forIssue && !o.name) throw bad('Every medication needs a name')
    return o
  })
}
const strList = (v: unknown, n: number, max: number): string[] => { if (v === undefined) return []; if (!Array.isArray(v) || v.length > n || v.some((x) => typeof x !== 'string' || x.length > max)) throw bad(); return v as string[] }

const COLS = 'id, patient_id, created_by, dentist_id, appointment_id, template_id, status, number, items, notes, acknowledged, snapshot, corrects_id, correction_reason, superseded_by_id, version, created_at, updated_at, issued_at, voided_at, void_reason'
const view = (r: Record<string, unknown>) => ({ id: r.id, patientId: r.patient_id, dentistId: r.dentist_id ?? undefined, appointmentId: r.appointment_id ?? undefined, templateId: r.template_id ?? undefined, status: r.status, number: r.number ?? undefined, items: parseJson(r.items) ?? [], notes: r.notes ?? undefined, acknowledged: parseJson(r.acknowledged) ?? [], snapshot: parseJson(r.snapshot) ?? undefined, correctsId: r.corrects_id ?? undefined, correctionReason: r.correction_reason ?? undefined, supersededById: r.superseded_by_id ?? undefined, version: Number(r.version), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), issuedAt: iso(r.issued_at), voidedAt: iso(r.voided_at), voidReason: r.void_reason ?? undefined })
const event = (db: Db, clinicId: string, rxId: string, kind: string, now: number, staffId: string | null, note: string | null) => db.run('INSERT INTO prescription_event (id, clinic_id, prescription_id, kind, at, staff_id, note) VALUES ($1,$2,$3,$4,$5,$6,$7)', [newId(), clinicId, rxId, kind, toDb(now), staffId, note])
async function own(db: Db, clinicId: string, id: string, lock = false) { if (!isUuid(id)) throw notFound(); const [r] = await db.rows<Record<string, unknown>>(`SELECT ${COLS} FROM prescription WHERE id = $1 AND clinic_id = $2${lock ? ' FOR UPDATE' : ''}`, [id, clinicId]); if (!r) throw notFound(); return r }
const uid = (v: unknown): string | null => { const t = opt(v, 64); if (t && !isUuid(t)) throw bad(); return t }
async function dentistOk(db: Db, clinicId: string, id: string | null) { if (id && !(await db.rows('SELECT 1 FROM dentist_profile WHERE id = $1 AND clinic_id = $2 AND archived_at IS NULL', [id, clinicId])).length) throw bad('Unknown dentist') }
async function patientOk(db: Db, clinicId: string, id: string) { if (!isUuid(id) || !(await db.rows('SELECT 1 FROM patient WHERE id = $1 AND clinic_id = $2 AND archived_at IS NULL', [id, clinicId])).length) throw notFound() }
const curIn = (raw: string | undefined) => { const cur = decodeCursor(raw); if (cur === null) throw bad('cursor'); return cur }

// ---- templates: clinic-wide or personal to the dentist who made them. Copy on use. ----
const visibleTpl = (clinicId: string, staffId: string) => ({ sql: "clinic_id = $1 AND archived_at IS NULL AND (scope = 'clinic' OR owner_staff_id = $2)", args: [clinicId, staffId] as unknown[] })
const tplView = (r: Record<string, unknown>) => ({ id: r.id, scope: r.scope, name: r.name, description: r.description ?? undefined, items: parseJson(r.items) ?? [], version: Number(r.version), updatedAt: iso(r.updated_at) })
prescriptionRoutes.get('/rx-templates', requires('clinical.view'), async (c) => {
  const p = c.get('principal'), v = visibleTpl(p.clinicId, p.staffId), limit = parseLimit(c.req.query('limit')); if (!limit) throw bad('limit')
  const cur = curIn(c.req.query('cursor')); if (cur && !isUuid(cur[1])) throw bad('cursor')
  const args = [...v.args]; let w = ''
  if (cur) { args.push(cur[0], cur[1]); w = ' AND (name, id) > ($3, $4::uuid)' }
  args.push(limit + 1)
  const rows = await c.get('db').rows(`SELECT id, scope, name, description, items, version, updated_at FROM rx_template WHERE ${v.sql}${w} ORDER BY name, id LIMIT $${args.length}`, args)
  const r = page(rows, limit, (x) => encodeCursor(String(x.name), String(x.id))); return c.json({ items: r.items.map(tplView), nextCursor: r.nextCursor })
})
const tplInput = async (c: Parameters<typeof body>[0]) => { const b = await body(c), name = opt(b.name, 120); if (!name) throw bad('Name required'); return { b, name, description: opt(b.description, 500), items: cleanItems(b.items, false).map((i) => { const { internalNotes: _x, ...rest } = i; return i.internalNotes ? i : rest }) } }
prescriptionRoutes.post('/rx-templates', requires('clinical.create'), async (c) => {
  const p = c.get('principal'), t = await tplInput(c), scope = t.b.scope === 'clinic' ? 'clinic' : t.b.scope === 'dentist' || t.b.scope === undefined ? 'dentist' : (() => { throw bad('scope') })()
  if (scope === 'clinic' && !p.permissions.has('clinical.approve')) throw new ApiError(403, 'forbidden', 'Not allowed')
  const id = newId(), now = toDb(c.get('now'))
  await c.get('db').run('INSERT INTO rx_template (id, clinic_id, scope, owner_staff_id, name, description, items, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$8)', [id, p.clinicId, scope, scope === 'dentist' ? p.staffId : null, t.name, t.description, JSON.stringify(t.items), now])
  return c.json({ id }, 201)
})
prescriptionRoutes.put('/rx-templates/:id', requires('clinical.edit'), async (c) => {
  const p = c.get('principal'), t = await tplInput(c), ev = t.b.expectedVersion; if (!Number.isInteger(ev)) throw bad('expectedVersion')
  const tid = c.req.param('id'); if (!isUuid(tid)) throw notFound()
  const [r] = await c.get('db').rows<{ scope: string; owner_staff_id: string | null }>('SELECT scope, owner_staff_id FROM rx_template WHERE id = $1 AND clinic_id = $2 AND archived_at IS NULL', [tid, p.clinicId])
  if (!r || (r.scope === 'dentist' && r.owner_staff_id !== p.staffId)) throw notFound()
  if (r.scope === 'clinic' && !p.permissions.has('clinical.approve')) throw new ApiError(403, 'forbidden', 'Not allowed')
  const n = await c.get('db').run('UPDATE rx_template SET name = $1, description = $2, items = $3::jsonb, version = version + 1, updated_at = $4 WHERE id = $5 AND clinic_id = $6 AND version = $7 AND archived_at IS NULL', [t.name, t.description, JSON.stringify(t.items), toDb(c.get('now')), tid, p.clinicId, ev])
  if (n !== 1) throw conflict('This template changed; reload and try again'); return c.body(null, 204)
})
prescriptionRoutes.delete('/rx-templates/:id', requires('clinical.edit'), async (c) => {
  const p = c.get('principal'), tid = c.req.param('id'); if (!isUuid(tid)) throw notFound()
  const n = await c.get('db').run("UPDATE rx_template SET archived_at = $1 WHERE id = $2 AND clinic_id = $3 AND archived_at IS NULL AND (owner_staff_id = $4 OR (scope = 'clinic' AND $5::boolean))", [toDb(c.get('now')), tid, p.clinicId, p.staffId, p.permissions.has('clinical.approve')])
  if (n !== 1) throw notFound(); return c.body(null, 204)
})

// ---- prescriptions ----
prescriptionRoutes.get('/patients/:id/prescriptions', requires('clinical.view'), async (c) => {
  const p = c.get('principal'), limit = parseLimit(c.req.query('limit')); if (!limit) throw bad('limit')
  const cur = curIn(c.req.query('cursor')); if (cur && (!isUuid(cur[1]) || Number.isNaN(Date.parse(cur[0])))) throw bad('cursor')
  const pid = c.req.param('id'); await patientOk(c.get('db'), p.clinicId, pid)
  const args: unknown[] = [p.clinicId, pid]; let w = ''
  if (cur) { args.push(cur[0], cur[1]); w = ' AND (created_at, id) < ($3::timestamptz, $4::uuid)' }
  args.push(limit + 1)
  const rows = await c.get('db').rows(`SELECT id, patient_id, dentist_id, status, number, items, version, created_at, issued_at, voided_at FROM prescription WHERE clinic_id = $1 AND patient_id = $2${w} ORDER BY created_at DESC, id DESC LIMIT $${args.length}`, args)
  const r = page(rows, limit, (x) => encodeCursor(String(x.created_at), String(x.id)))
  return c.json({ items: r.items.map((x) => ({ id: x.id, dentistId: x.dentist_id ?? undefined, status: x.status, number: x.number ?? undefined, medications: (x.items as { name?: string }[]).map((i) => i.name).filter(Boolean), createdAt: iso(x.created_at), issuedAt: iso(x.issued_at), voidedAt: iso(x.voided_at) })), nextCursor: r.nextCursor })
})
prescriptionRoutes.post('/patients/:id/prescriptions', requires('clinical.create'), async (c) => {
  const p = c.get('principal'), b = await body(c), pid = c.req.param('id'), id = newId(), now = toDb(c.get('now'))
  const dentistId = uid(b.dentistId), templateId = uid(b.templateId), apptId = uid(b.appointmentId); let items = cleanItems(b.items, false)
  await c.get('db').tx(async (db) => {
    await patientOk(db, p.clinicId, pid); await dentistOk(db, p.clinicId, dentistId)
    if (apptId && !(await db.rows('SELECT 1 FROM appointment WHERE id = $1 AND clinic_id = $2 AND patient_id = $3', [apptId, p.clinicId, pid])).length) throw bad('Unknown appointment')
    if (templateId) { // copy values; the template is never read again for this prescription
      const v = visibleTpl(p.clinicId, p.staffId), [t] = await db.rows<{ items: Record<string, unknown>[] }>(`SELECT items FROM rx_template WHERE id = $3::uuid AND ${v.sql}`, [...v.args, templateId])
      if (!t) throw bad('Unknown template'); if (!items.length) items = t.items.map((i) => ({ ...i, id: newId() }))
    }
    await db.run("INSERT INTO prescription (id, clinic_id, patient_id, dentist_id, appointment_id, template_id, status, items, notes, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,'draft',$7::jsonb,$8,$9,$10,$10)", [id, p.clinicId, pid, dentistId, apptId, templateId, JSON.stringify(items), opt(b.notes, 2000), p.staffId, now])
  })
  return c.json({ id }, 201)
})
prescriptionRoutes.get('/prescriptions/:id', requires('clinical.view'), async (c) => c.json(view(await own(c.get('db'), c.get('principal').clinicId, c.req.param('id')))))
prescriptionRoutes.get('/prescriptions/:id/history', requires('clinical.view'), async (c) => {
  const p = c.get('principal'); await own(c.get('db'), p.clinicId, c.req.param('id'))
  const rows = await c.get('db').rows("SELECT kind, at, staff_id, note FROM prescription_event WHERE clinic_id = $1 AND prescription_id = $2 ORDER BY at, CASE kind WHEN 'created' THEN 0 WHEN 'issued' THEN 1 WHEN 'superseded' THEN 2 ELSE 3 END, id LIMIT 100", [p.clinicId, c.req.param('id')])
  return c.json({ items: rows.map((x) => ({ kind: x.kind, at: iso(x.at), staffId: x.staff_id ?? undefined, note: x.note ?? undefined })) })
})
// Edit a draft. The WHERE status='draft' AND version=? is the arbiter: an issued prescription can never be changed, whatever races.
prescriptionRoutes.put('/prescriptions/:id', requires('clinical.edit'), async (c) => {
  const p = c.get('principal'), db = c.get('db'), b = await body(c); if (!Number.isInteger(b.expectedVersion)) throw bad('expectedVersion')
  const cur = await own(db, p.clinicId, c.req.param('id')); if (cur.status !== 'draft') throw conflict('Only drafts can be edited')
  const dentistId = b.dentistId === undefined ? (cur.dentist_id as string | null) : uid(b.dentistId); await dentistOk(db, p.clinicId, dentistId)
  const items = b.items === undefined ? parseJson(cur.items) : cleanItems(b.items, false), notes = b.notes === undefined ? (cur.notes as string | null) : opt(b.notes, 2000)
  const n = await db.run("UPDATE prescription SET dentist_id = $1, items = $2::jsonb, notes = $3, version = version + 1, updated_at = $4 WHERE id = $5 AND clinic_id = $6 AND status = 'draft' AND version = $7", [dentistId, JSON.stringify(items), notes, toDb(c.get('now')), c.req.param('id'), p.clinicId, b.expectedVersion])
  if (n !== 1) throw conflict('This prescription changed; reload and try again'); return c.body(null, 204)
})
prescriptionRoutes.delete('/prescriptions/:id', requires('clinical.edit'), async (c) => {
  const p = c.get('principal'); if (!isUuid(c.req.param('id'))) throw notFound()
  const n = await c.get('db').run("DELETE FROM prescription WHERE id = $1 AND clinic_id = $2 AND status = 'draft'", [c.req.param('id'), p.clinicId])
  if (n !== 1) throw conflict('Only drafts can be discarded'); return c.body(null, 204)
})
// Issue: needs clinical.approve, a dentist, at least one named medication. One transaction: freezes the snapshot, takes the next gap-free RX-YYYY-NNNN, supersedes the original of a correction.
prescriptionRoutes.post('/prescriptions/:id/issue', requires('clinical.approve'), async (c) => {
  const p = c.get('principal'), b = await body(c), ev = b.expectedVersion; if (!Number.isInteger(ev)) throw bad('expectedVersion')
  const acknowledged = strList(b.acknowledged, 50, 200), now = c.get('now')
  const number = await c.get('db').tx(async (db) => {
    const cur = await own(db, p.clinicId, c.req.param('id'), true); if (cur.status !== 'draft') throw conflict('Only drafts can be issued')
    if (cur.version !== ev) throw conflict('This prescription changed; reload and try again')
    if (!cur.dentist_id) throw bad('Choose the prescribing dentist'); cleanItems(cur.items, true)
    if (cur.corrects_id) { const [o] = await db.rows<{ status: string }>('SELECT status FROM prescription WHERE id = $1 AND clinic_id = $2 FOR UPDATE', [cur.corrects_id, p.clinicId]); if (o?.status !== 'issued') throw conflict('The prescription being corrected is no longer issued') }
    const [cl] = await db.rows<{ name: string; timezone: string }>('SELECT name, timezone FROM clinic WHERE id = $1', [p.clinicId])
    const [d] = await db.rows<Record<string, string | null>>('SELECT name, specialty, registration, phone, email FROM dentist_profile WHERE id = $1 AND clinic_id = $2', [cur.dentist_id, p.clinicId])
    const [pt] = await db.rows<Record<string, string | null>>('SELECT full_name, birth_date::text AS birth_date, sex, phone FROM patient WHERE id = $1 AND clinic_id = $2', [cur.patient_id, p.clinicId])
    if (!cl || !d || !pt) throw notFound()
    const drop = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v))
    const snapshot = { clinic: drop({ name: cl.name }), dentist: drop({ name: d.name, specialty: d.specialty, registration: d.registration, phone: d.phone, email: d.email }), patient: drop({ name: pt.full_name, birthDate: pt.birth_date, sex: pt.sex, phone: pt.phone }) }
    const year = yearIn(cl.timezone, now), seq = await nextSeq(db, p.clinicId, 'prescription', year), num = `RX-${year}-${String(seq).padStart(4, '0')}`
    await db.run("UPDATE prescription SET status = 'issued', number = $1, number_year = $2, seq = $3, snapshot = $4::jsonb, acknowledged = $5::jsonb, issued_at = $6, issued_by = $7, version = version + 1, updated_at = $6 WHERE id = $8 AND clinic_id = $9",
      [num, year, seq, JSON.stringify(snapshot), JSON.stringify(acknowledged), toDb(now), p.staffId, cur.id, p.clinicId])
    await db.run('INSERT INTO prescription_event (id, clinic_id, prescription_id, kind, at, staff_id, note) VALUES ($1,$2,$3,$4,$5,$6,$7)', [newId(), p.clinicId, cur.id, 'created', toDb(Date.parse(String(cur.created_at))), cur.created_by ?? null, cur.correction_reason ?? null])
    await event(db, p.clinicId, String(cur.id), 'issued', now, p.staffId, null)
    if (cur.corrects_id) { // the original is replaced only after the correction exists
      await db.run("UPDATE prescription SET status = 'superseded', superseded_by_id = $1, updated_at = $2 WHERE id = $3 AND clinic_id = $4 AND status = 'issued'", [cur.id, toDb(now), cur.corrects_id, p.clinicId])
      await event(db, p.clinicId, String(cur.corrects_id), 'superseded', now, p.staffId, String(cur.correction_reason ?? ''))
    }
    return num
  })
  return c.json({ number })
})
// Void an issued prescription (reason mandatory). It stays in the record.
prescriptionRoutes.post('/prescriptions/:id/void', requires('clinical.void'), async (c) => {
  const p = c.get('principal'), reason = reasonOf(await body(c))
  await c.get('db').tx(async (db) => {
    const cur = await own(db, p.clinicId, c.req.param('id'), true); if (cur.status !== 'issued') throw conflict('Only issued prescriptions can be voided')
    await db.run("UPDATE prescription SET status = 'voided', voided_at = $1, void_reason = $2, version = version + 1, updated_at = $1 WHERE id = $3 AND clinic_id = $4", [toDb(c.get('now')), reason, cur.id, p.clinicId])
    await event(db, p.clinicId, String(cur.id), 'voided', c.get('now'), p.staffId, reason)
  })
  return c.body(null, 204)
})
// Correct an issued prescription: a new linked draft with copied items. The original is superseded only when the correction is issued.
prescriptionRoutes.post('/prescriptions/:id/correct', requires('clinical.create'), async (c) => {
  const p = c.get('principal'), reason = reasonOf(await body(c)), id = newId(), now = toDb(c.get('now'))
  await c.get('db').tx(async (db) => {
    const o = await own(db, p.clinicId, c.req.param('id'), true); if (o.status !== 'issued') throw conflict('Only issued prescriptions can be corrected')
    if ((await db.rows("SELECT 1 FROM prescription WHERE clinic_id = $1 AND corrects_id = $2 AND status = 'draft'", [p.clinicId, o.id])).length) throw conflict('A correction is already in progress')
    await db.run("INSERT INTO prescription (id, clinic_id, patient_id, dentist_id, appointment_id, status, items, notes, corrects_id, correction_reason, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,'draft',$6::jsonb,$7,$8,$9,$10,$11,$11)",
      [id, p.clinicId, o.patient_id, o.dentist_id, o.appointment_id, JSON.stringify((o.items as Record<string, unknown>[]).map((i) => ({ ...i, id: newId() }))), o.notes, o.id, reason, p.staffId, now])
  })
  return c.json({ id }, 201)
})

// ---- A4 print, English or French. Every dynamic value is HTML-escaped; the response carries a CSP that blocks scripts. ----
export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
const L = { en: { title: 'Prescription', patient: 'Patient', born: 'Born', dentist: 'Dentist', reg: 'Registration no.', dose: 'Dosage', freq: 'Frequency', dur: 'Duration', qty: 'Quantity', refills: 'Refills', notes: 'Notes', voided: 'VOID', draft: 'DRAFT - not valid', issued: 'Issued' }, fr: { title: 'Ordonnance', patient: 'Patient', born: 'Né(e) le', dentist: 'Dentiste', reg: "N° d'inscription", dose: 'Posologie', freq: 'Fréquence', dur: 'Durée', qty: 'Quantité', refills: 'Renouvellements', notes: 'Remarques', voided: 'ANNULÉE', draft: 'BROUILLON - non valide', issued: 'Émise le' } }
prescriptionRoutes.get('/prescriptions/:id/print', requires('clinical.view'), async (c) => {
  const r = view(await own(c.get('db'), c.get('principal').clinicId, c.req.param('id'))), t = L[c.req.query('lang') === 'fr' ? 'fr' : 'en'], s = (r.snapshot ?? {}) as { clinic?: { name?: string }; dentist?: Record<string, string>; patient?: Record<string, string> }
  const mark = r.status === 'voided' ? t.voided : r.status === 'draft' ? t.draft : ''
  const lines = (r.items as Record<string, string>[]).map((i) => `<li><b>${esc([i.name, i.strength, i.form].filter(Boolean).join(' '))}</b>${i.brand || i.generic ? ` <i>(${esc(i.brand ?? i.generic)})</i>` : ''}<br>${[['dose', i.dosage], ['freq', i.frequency], ['dur', i.duration], ['qty', i.quantity], ['refills', i.refills]].filter(([, v]) => v).map(([k, v]) => `${esc(t[k as 'dose'])}: ${esc(v)}`).join(' · ')}${i.instructions ? `<br>${esc(i.instructions)}` : ''}</li>`).join('')
  const html = `<!doctype html><html lang="${c.req.query('lang') === 'fr' ? 'fr' : 'en'}"><meta charset="utf-8"><title>${esc(t.title)} ${esc(r.number ?? '')}</title><style>@page{size:A4;margin:18mm}body{font:12pt/1.4 sans-serif;color:#000}h1{font-size:18pt;margin:0}.mark{font-size:28pt;color:#b00;border:3px solid #b00;display:inline-block;padding:2px 12px;transform:rotate(-6deg)}li{margin:0 0 10pt}</style><body><h2>${esc(s.clinic?.name)}</h2><h1>${esc(t.title)} ${esc(r.number ?? '')}</h1>${mark ? `<p class="mark">${esc(mark)}</p>` : ''}<p>${esc(t.patient)}: <b>${esc(s.patient?.name)}</b>${s.patient?.birthDate ? ` — ${esc(t.born)} ${esc(s.patient.birthDate)}` : ''}</p><ol>${lines}</ol>${r.notes ? `<p><b>${esc(t.notes)}:</b> ${esc(r.notes)}</p>` : ''}<p>${esc(t.dentist)}: <b>${esc(s.dentist?.name)}</b>${s.dentist?.registration ? ` — ${esc(t.reg)} ${esc(s.dentist.registration)}` : ''}<br>${r.issuedAt ? `${esc(t.issued)} ${esc(String(r.issuedAt).slice(0, 10))}` : ''}</p></body></html>`
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' } })
})
