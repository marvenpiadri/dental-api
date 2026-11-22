import { Hono } from 'hono'
import { ApiError, fail } from '../http/errors'
import { authenticate, requires } from '../http/middleware'
import type { AppEnv } from '../http/context'
import { decodeCursor, encodeCursor, page, parseLimit } from '../lib/pagination'
import { isUuid, newId } from '../lib/ids'
import { nextSeq, patientNumber } from '../lib/numbering'
import { toDb } from '../lib/time'

export const patientRoutes = new Hono<AppEnv>()
patientRoutes.use('*', authenticate)
patientRoutes.onError((e, c) => { if (e instanceof ApiError) return fail(c, e); throw e })

const bad = (m = 'Invalid request') => new ApiError(400, 'bad_request', m)
const notFound = () => new ApiError(404, 'not_found', 'Not found')
/** Lowercase, accent-free: "Élodie" and "elodie" are the same search key. */
export const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()
const likeEscape = (s: string) => s.replace(/[!%_]/g, (x) => '!' + x)

const optStr = (v: unknown, max: number): string | null => {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string' || v.length > max) throw bad(); return v.trim()
}
const date = (v: unknown): string | null => {
  const s = optStr(v, 10); if (s === null) return null
  const d = /^(\d{4})-(\d\d)-(\d\d)$/.exec(s), t = d && new Date(Date.UTC(+d[1], +d[2] - 1, +d[3]))
  if (!d || !t || t.getUTCFullYear() !== +d[1] || t.getUTCMonth() !== +d[2] - 1 || t.getUTCDate() !== +d[3]) throw bad('birthDate must be a real YYYY-MM-DD date')
  return s
}
const oneOf = (v: unknown, allowed: readonly string[], name: string): string | null => {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string' || !allowed.includes(v)) throw bad(`${name} must be one of ${allowed.join(', ')}`); return v
}
const FIELDS = 'id, number, full_name, phone, email, birth_date, sex, country, city, address, emergency_name, emergency_phone, language, referral, alert, notes, whatsapp_consent, whatsapp_consent_at, created_at, archived_at, photo_file_id'
const view = (r: Record<string, unknown>) => ({ id: r.id, number: r.number, fullName: r.full_name, phone: r.phone, email: r.email, birthDate: r.birth_date, sex: r.sex, country: r.country, city: r.city,
  address: r.address, emergencyName: r.emergency_name, emergencyPhone: r.emergency_phone, language: r.language, referral: r.referral, alert: r.alert, notes: r.notes,
  whatsappConsent: r.whatsapp_consent, whatsappConsentAt: r.whatsapp_consent_at, createdAt: r.created_at, archivedAt: r.archived_at, photoFileId: r.photo_file_id ?? null })

const TEXT: [string, string, number][] = [['phone', 'phone', 40], ['email', 'email', 254], ['country', 'country', 64], ['city', 'city', 100], ['address', 'address', 300],
  ['emergencyName', 'emergency_name', 200], ['emergencyPhone', 'emergency_phone', 40], ['referral', 'referral', 200], ['alert', 'alert', 500], ['notes', 'notes', 2000]]
const parse = async (c: { req: { json: () => Promise<unknown> } }, partial: boolean, now: number) => {
  const b = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad()
  const out: Record<string, unknown> = {}
  if (!partial || b.fullName !== undefined) { const n = optStr(b.fullName, 200); if (!n) throw bad('fullName is required'); out.full_name = n; out.search_name = norm(n) }
  for (const [k, col, max] of TEXT) if (!partial || b[k] !== undefined) out[col] = optStr(b[k], max)
  if (!partial || b.sex !== undefined) out.sex = oneOf(b.sex, ['female', 'male'], 'sex')
  if (!partial || b.language !== undefined) out.language = oneOf(b.language, ['en', 'fr'], 'language')
  if (!partial || b.birthDate !== undefined) out.birth_date = date(b.birthDate)
  if (b.whatsappConsent !== undefined) { out.whatsapp_consent = oneOf(b.whatsappConsent, ['granted', 'declined'], 'whatsappConsent'); out.whatsapp_consent_at = out.whatsapp_consent ? toDb(now) : null }
  if (out.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.email as string)) throw bad('email is not valid')
  return out
}

// Search (name contains, or phone contains) is keyset-paginated on (search_name, id). Archived patients are hidden unless asked for.
patientRoutes.get('/', requires('patients.view'), async (c) => {
  const q = c.req.query(), limit = parseLimit(q.limit); if (limit === null) throw bad('limit must be 1-100')
  const cur = decodeCursor(q.cursor); if (cur === null || (cur && !isUuid(cur[1]))) throw bad('Invalid cursor')
  if (q.q !== undefined && q.q.length > 100) throw bad()
  const p: unknown[] = [c.get('principal').clinicId]; let where = ''
  const add = (v: unknown) => `$${p.push(v)}`
  if (q.q?.trim()) { const like = add('%' + likeEscape(norm(q.q)) + '%'); where += ` AND (search_name LIKE ${like} ESCAPE '!' OR phone LIKE ${like} ESCAPE '!' OR lower(number) LIKE ${like} ESCAPE '!')` }
  if (q.archived !== 'true') where += ' AND archived_at IS NULL'
  if (cur) { const a = add(cur[0]); where += ` AND (search_name, id) > (${a}, ${add(cur[1])}::uuid)` }
  const rows = await c.get('db').rows(`SELECT ${FIELDS}, search_name FROM patient WHERE clinic_id = $1${where} ORDER BY search_name, id LIMIT ${add(limit + 1)}`, p)
  const r = page(rows, limit, (x) => encodeCursor(String(x.search_name), String(x.id)))
  return c.json({ items: r.items.map(view), nextCursor: r.nextCursor })
})

// Core record only. Medical history, charts, treatments, invoices and documents are separate section endpoints (loaded on demand).
patientRoutes.get('/:id', requires('patients.view'), async (c) => {
  const id = c.req.param('id'); if (!isUuid(id)) throw notFound()
  const [r] = await c.get('db').rows(`SELECT ${FIELDS} FROM patient WHERE id = $1 AND clinic_id = $2`, [id, c.get('principal').clinicId])
  if (!r) throw notFound()
  return c.json(view(r))
})

patientRoutes.post('/', requires('patients.create'), async (c) => {
  const f = await parse(c, false, c.get('now')), id = newId(), clinicId = c.get('principal').clinicId
  const number = await c.get('db').tx(async (db) => {
    const number = patientNumber(await nextSeq(db, clinicId, 'patient')) // same transaction: a failed insert gives the number back
    const cols = ['id', 'clinic_id', 'number', 'created_at', ...Object.keys(f)], vals = [id, clinicId, number, toDb(c.get('now')), ...Object.values(f)]
    await db.run(`INSERT INTO patient (${cols.join(', ')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')})`, vals)
    return number
  })
  return c.json({ id, number }, 201)
})

patientRoutes.patch('/:id', requires('patients.edit'), async (c) => {
  const id = c.req.param('id'); if (!isUuid(id)) throw notFound()
  const f = await parse(c, true, c.get('now')), keys = Object.keys(f)
  if (!keys.length) throw bad('nothing to update')
  const n = await c.get('db').run(`UPDATE patient SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1} AND clinic_id = $${keys.length + 2}`, [...keys.map((k) => f[k]), id, c.get('principal').clinicId])
  if (n !== 1) throw notFound()
  return c.body(null, 204)
})

// Patients are archived, never deleted (clinical and billing history refer to them).
patientRoutes.post('/:id/archive', requires('patients.manage'), async (c) => {
  const id = c.req.param('id'); if (!isUuid(id)) throw notFound()
  const n = await c.get('db').run('UPDATE patient SET archived_at = $1 WHERE id = $2 AND clinic_id = $3 AND archived_at IS NULL', [toDb(c.get('now')), id, c.get('principal').clinicId])
  if (n !== 1) throw notFound()
  return c.body(null, 204)
})
