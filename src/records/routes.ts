import { Hono } from 'hono'
import { ApiError, fail } from '../http/errors'
import { authenticate, requires } from '../http/middleware'
import type { AppEnv } from '../http/context'
import type { Db } from '../db/client'
import { decodeCursor, encodeCursor, page, parseLimit } from '../lib/pagination'
import { isUuid, newId } from '../lib/ids'
import { toDb } from '../lib/time'

/** Smaller patient-file sections, each loaded on demand: letters, insurance, the waiting list, WhatsApp messages. */
export const recordRoutes = new Hono<AppEnv>()
recordRoutes.use('*', authenticate)
recordRoutes.onError((e, c) => { if (e instanceof ApiError) return fail(c, e); throw e })
const bad = (m = 'Invalid request') => new ApiError(400, 'bad_request', m)
const notFound = () => new ApiError(404, 'not_found', 'Not found')
const body = async (c: { req: { json: () => Promise<unknown> } }) => { const b = await c.req.json().catch(() => null); if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad(); return b as Record<string, unknown> }
const str = (v: unknown, max: number, required = false): string | null => { if (v === undefined || v === null || v === '') { if (required) throw bad(); return null } if (typeof v !== 'string' || v.length > max) throw bad(); const t = v.trim(); if (!t && required) throw bad(); return t || null }
const patientOk = async (db: Db, clinicId: string, id: string) => { if (!isUuid(id) || !(await db.rows('SELECT 1 FROM patient WHERE id = $1 AND clinic_id = $2', [id, clinicId])).length) throw notFound() }
const cursor = (raw: string | undefined) => { const cur = decodeCursor(raw); if (cur === null || (cur && (!isUuid(cur[1]) || Number.isNaN(Date.parse(cur[0]))))) throw bad('Invalid cursor'); return cur }

/** Newest-first keyset page over (ts, id). `where` already holds $1 (clinic) and $2 (patient). */
async function pageOf(c: { get: (k: 'db') => Db; req: { query: () => Record<string, string> } }, table: string, cols: string, ts: string, clinicId: string, patientId: string, extra = '') {
  const q = c.req.query(), limit = parseLimit(q.limit); if (limit === null) throw bad('limit must be 1-100'); const cur = cursor(q.cursor)
  const args: unknown[] = [clinicId, patientId]; let w = ''
  if (cur) { args.push(cur[0], cur[1]); w = ` AND (${ts}, id) < ($3::timestamptz, $4::uuid)` }
  args.push(limit + 1)
  const rows = await c.get('db').rows(`SELECT ${cols}, ${ts} AS ts FROM ${table} WHERE clinic_id = $1 AND patient_id = $2${extra}${w} ORDER BY ${ts} DESC, id DESC LIMIT $${args.length}`, args)
  return page(rows, limit, (x) => encodeCursor(String(x.ts), String(x.id)))
}

// ---- letters: written once, never edited ----
recordRoutes.get('/patients/:id/letters', requires('clinical.view'), async (c) => {
  const p = c.get('principal'), pid = c.req.param('id'); await patientOk(c.get('db'), p.clinicId, pid)
  const r = await pageOf(c, 'letter', 'id, kind, dentist_id, to_whom, rest_days, text', 'at', p.clinicId, pid)
  return c.json({ items: r.items.map((x) => ({ id: x.id, at: x.ts, kind: x.kind, dentistId: x.dentist_id ?? undefined, to: x.to_whom ?? undefined, restDays: x.rest_days ?? undefined, text: x.text })), nextCursor: r.nextCursor })
})
recordRoutes.post('/patients/:id/letters', requires('clinical.create'), async (c) => {
  const p = c.get('principal'), b = await body(c), pid = c.req.param('id'), id = newId()
  if (b.kind !== 'certificate' && b.kind !== 'referral') throw bad('kind must be certificate or referral')
  const dentist = str(b.dentistId, 64); if (dentist && !isUuid(dentist)) throw bad()
  const rest = b.restDays; if (rest !== undefined && (b.kind !== 'certificate' || !Number.isInteger(rest) || (rest as number) < 0 || (rest as number) > 365)) throw bad('restDays is for certificates, 0-365')
  const to = str(b.to, 200); if (to && b.kind !== 'referral') throw bad('"to" is for referral letters')
  await c.get('db').tx(async (db) => {
    await patientOk(db, p.clinicId, pid)
    if (dentist && !(await db.rows('SELECT 1 FROM dentist_profile WHERE id = $1 AND clinic_id = $2', [dentist, p.clinicId])).length) throw notFound()
    await db.run('INSERT INTO letter (id, clinic_id, patient_id, kind, dentist_id, to_whom, rest_days, text, at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [id, p.clinicId, pid, b.kind, dentist, to, rest ?? null, str(b.text, 6000, true), toDb(c.get('now')), p.staffId])
  })
  return c.json({ id }, 201)
})

// ---- insurance: who covers the patient ----
const insView = (r: Record<string, unknown>) => ({ id: r.id, providerId: r.provider_id, providerName: r.provider_name, number: r.number, policy: r.policy ?? undefined, notes: r.notes ?? undefined, addedAt: r.added_at })
recordRoutes.get('/patients/:id/insurances', requires('patients.view'), async (c) => {
  const p = c.get('principal'), pid = c.req.param('id'); await patientOk(c.get('db'), p.clinicId, pid)
  const rows = await c.get('db').rows('SELECT id, provider_id, provider_name, number, policy, notes, added_at FROM patient_insurance WHERE clinic_id = $1 AND patient_id = $2 AND removed_at IS NULL ORDER BY added_at, id LIMIT 50', [p.clinicId, pid])
  return c.json({ items: rows.map(insView) })
})
recordRoutes.post('/patients/:id/insurances', requires('patients.edit'), async (c) => {
  const p = c.get('principal'), b = await body(c), pid = c.req.param('id'), id = newId()
  await c.get('db').tx(async (db) => {
    await patientOk(db, p.clinicId, pid)
    const [n] = await db.rows<{ n: string }>('SELECT count(*) n FROM patient_insurance WHERE patient_id = $1 AND removed_at IS NULL', [pid]); if (Number(n.n) >= 20) throw new ApiError(409, 'limit', 'Too many insurances on this patient')
    await db.run('INSERT INTO patient_insurance (id, clinic_id, patient_id, provider_id, provider_name, number, policy, notes, added_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, p.clinicId, pid, str(b.providerId, 60, true), str(b.providerName, 120, true), str(b.number, 40, true), str(b.policy, 60), str(b.notes, 500), toDb(c.get('now'))])
  })
  return c.json({ id }, 201)
})
recordRoutes.delete('/insurances/:id', requires('patients.edit'), async (c) => {
  const id = c.req.param('id'); if (!isUuid(id)) throw notFound()
  if ((await c.get('db').run('UPDATE patient_insurance SET removed_at = $1 WHERE id = $2 AND clinic_id = $3 AND removed_at IS NULL', [toDb(c.get('now')), id, c.get('principal').clinicId])) !== 1) throw notFound(); return c.body(null, 204)
})

// ---- waiting list ----
recordRoutes.get('/waiting', requires('appointments.view'), async (c) => {
  const q = c.req.query(), limit = parseLimit(q.limit); if (limit === null) throw bad('limit must be 1-100'); const cur = cursor(q.cursor)
  const args: unknown[] = [c.get('principal').clinicId]; let w = ''
  if (cur) { args.push(cur[0], cur[1]); w = ' AND (waiting_since, id) > ($2::timestamptz, $3::uuid)' }
  args.push(limit + 1)
  const rows = await c.get('db').rows(`SELECT id, number, full_name, phone, waiting_since FROM patient WHERE clinic_id = $1 AND waiting_since IS NOT NULL AND archived_at IS NULL${w} ORDER BY waiting_since, id LIMIT $${args.length}`, args)
  const r = page(rows, limit, (x) => encodeCursor(String(x.waiting_since), String(x.id)))
  return c.json({ items: r.items.map((x) => ({ patientId: x.id, number: x.number, fullName: x.full_name, phone: x.phone ?? undefined, since: x.waiting_since })), nextCursor: r.nextCursor })
})
recordRoutes.put('/patients/:id/waiting', requires('appointments.edit'), async (c) => {
  const id = c.req.param('id'); if (!isUuid(id)) throw notFound()
  const n = await c.get('db').run('UPDATE patient SET waiting_since = COALESCE(waiting_since, $1) WHERE id = $2 AND clinic_id = $3 AND archived_at IS NULL', [toDb(c.get('now')), id, c.get('principal').clinicId])
  if (n !== 1) throw notFound(); return c.body(null, 204)
})
recordRoutes.delete('/patients/:id/waiting', requires('appointments.edit'), async (c) => {
  const id = c.req.param('id'); if (!isUuid(id)) throw notFound()
  if ((await c.get('db').run('UPDATE patient SET waiting_since = NULL WHERE id = $1 AND clinic_id = $2', [id, c.get('principal').clinicId])) !== 1) throw notFound(); return c.body(null, 204)
})

// ---- WhatsApp messages: the clinic prepares them; a patient who declined is never messaged ----
recordRoutes.get('/patients/:id/messages', requires('patients.view'), async (c) => {
  const p = c.get('principal'), pid = c.req.param('id'); await patientOk(c.get('db'), p.clinicId, pid)
  const r = await pageOf(c, 'message', 'id, kind, text, status, appointment_id, external_id', 'at', p.clinicId, pid)
  return c.json({ items: r.items.map((x) => ({ id: x.id, at: x.ts, kind: x.kind, text: x.text, status: x.status, appointmentId: x.appointment_id ?? undefined, externalId: x.external_id ?? undefined })), nextCursor: r.nextCursor })
})
recordRoutes.post('/patients/:id/messages', requires('patients.edit'), async (c) => {
  const p = c.get('principal'), b = await body(c), pid = c.req.param('id'), id = newId()
  if (!['appointment', 'balance', 'recall'].includes(String(b.kind))) throw bad('Invalid kind')
  const appt = str(b.appointmentId, 64); if (appt && !isUuid(appt)) throw bad()
  await c.get('db').tx(async (db) => {
    const [pt] = await db.rows<{ whatsapp_consent: string | null }>('SELECT whatsapp_consent FROM patient WHERE id = $1 AND clinic_id = $2', [isUuid(pid) ? pid : '00000000-0000-0000-0000-000000000000', p.clinicId]); if (!pt) throw notFound()
    if (pt.whatsapp_consent === 'declined') throw new ApiError(409, 'consent_declined', 'This patient declined WhatsApp messages')
    if (appt && !(await db.rows('SELECT 1 FROM appointment WHERE id = $1 AND clinic_id = $2 AND patient_id = $3', [appt, p.clinicId, pid])).length) throw notFound()
    await db.run("INSERT INTO message (id, clinic_id, patient_id, kind, text, status, appointment_id, at, created_by) VALUES ($1,$2,$3,$4,$5,'prepared',$6,$7,$8)", [id, p.clinicId, pid, b.kind, str(b.text, 2000, true), appt, toDb(c.get('now')), p.staffId])
  })
  return c.json({ id }, 201)
})
// Status only moves forward: prepared -> sent -> delivered -> read, or failed.
const ORDER = ['prepared', 'sent', 'delivered', 'read']
recordRoutes.patch('/messages/:id', requires('patients.edit'), async (c) => {
  const id = c.req.param('id'), b = await body(c); if (!isUuid(id)) throw notFound()
  const st = String(b.status); if (!['sent', 'delivered', 'read', 'failed'].includes(st)) throw bad('Invalid status')
  const ext = str(b.externalId, 200)
  const n = await c.get('db').run(`UPDATE message SET status = $1, external_id = COALESCE($2, external_id) WHERE id = $3 AND clinic_id = $4 AND status <> 'failed' AND ($1 = 'failed' OR array_position($5::text[], status) < array_position($5::text[], $1))`, [st, ext, id, c.get('principal').clinicId, ORDER])
  if (n !== 1) throw new ApiError(409, 'conflict', 'Message not found or status cannot move back'); return c.body(null, 204)
})
