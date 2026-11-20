import { Hono } from 'hono'
import { ApiError } from '../http/errors'
import { authenticate, requires } from '../http/middleware'
import type { AppEnv } from '../http/context'
import { decodeCursor, encodeCursor, page, parseLimit } from '../lib/pagination'
import { newId } from '../lib/ids'
import { toDb } from '../lib/time'

export const patientRoutes = new Hono<AppEnv>()
patientRoutes.use('*', authenticate)
patientRoutes.onError((e, c) => { if (e instanceof ApiError) return c.json({ error: { code: e.code, message: e.message }, requestId: c.get('requestId') }, e.status); throw e })

const bad = (m = 'Invalid request') => new ApiError(400, 'bad_request', m)
/** Lowercase, accent-free: "Élodie" and "elodie" are the same search key in every database collation. */
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
const FIELDS = 'id, full_name, phone, email, birth_date, sex, country, city, alert, notes, created_at, archived_at'
const view = (r: Record<string, unknown>) => ({ id: r.id, fullName: r.full_name, phone: r.phone, email: r.email, birthDate: r.birth_date ? String(r.birth_date).slice(0, 10) : null,
  sex: r.sex, country: r.country, city: r.city, alert: r.alert, notes: r.notes, archivedAt: r.archived_at ?? null })
const parse = async (c: { req: { json: () => Promise<unknown> } }, partial: boolean) => {
  const b = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad()
  const out: Record<string, string | null> = {}
  if (!partial || b.fullName !== undefined) { const n = optStr(b.fullName, 200); if (!n) throw bad('fullName is required'); out.full_name = n; out.full_name_norm = norm(n) }
  if (b.sex !== undefined && b.sex !== null && b.sex !== 'female' && b.sex !== 'male') throw bad('sex must be female or male')
  const m: [string, unknown, number][] = [['phone', b.phone, 40], ['email', b.email, 254], ['sex', b.sex, 8], ['country', b.country, 64], ['city', b.city, 100], ['alert', b.alert, 500], ['notes', b.notes, 2000]]
  for (const [k, v, max] of m) if (!partial || v !== undefined) out[k] = optStr(v, max)
  if (!partial || b.birthDate !== undefined) out.birth_date = date(b.birthDate)
  if (out.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.email)) throw bad('email is not valid')
  return out
}

// Name search (prefix) is keyset-paginated on (full_name_norm, id). Archived patients are hidden unless asked for.
patientRoutes.get('/', requires('patients.view'), async (c) => {
  const q = c.req.query(), limit = parseLimit(q.limit); if (limit === null) throw bad('limit must be 1-100')
  const cur = decodeCursor(q.cursor); if (cur === null) throw bad('Invalid cursor')
  if (q.q !== undefined && q.q.length > 100) throw bad()
  const p: unknown[] = [c.get('principal').clinicId]; let where = ''
  if (q.q?.trim()) { where += " AND full_name_norm LIKE ? ESCAPE '!'"; p.push(likeEscape(norm(q.q)) + '%') }
  if (q.archived !== 'true') where += ' AND archived_at IS NULL'
  if (cur) { where += ' AND (full_name_norm > ? OR (full_name_norm = ? AND id > ?))'; p.push(cur[0], cur[0], cur[1]) }
  p.push(limit + 1)
  const rows = await c.get('db').rows(`SELECT ${FIELDS}, full_name_norm FROM patient WHERE clinic_id = ?${where} ORDER BY full_name_norm, id LIMIT ?`, p)
  const r = page(rows, limit, (x) => encodeCursor(String(x.full_name_norm), String(x.id)))
  return c.json({ items: r.items.map(view), nextCursor: r.nextCursor })
})

// Core record only. Medical history, charts, treatments, invoices and documents are separate section endpoints (loaded on demand).
patientRoutes.get('/:id', requires('patients.view'), async (c) => {
  const [r] = await c.get('db').rows(`SELECT ${FIELDS} FROM patient WHERE id = ? AND clinic_id = ?`, [c.req.param('id'), c.get('principal').clinicId])
  if (!r) throw new ApiError(404, 'not_found', 'Not found')
  return c.json(view(r))
})

patientRoutes.post('/', requires('patients.create'), async (c) => {
  const f = await parse(c, false), id = newId()
  await c.get('db').run('INSERT INTO patient (id, clinic_id, full_name, full_name_norm, phone, email, birth_date, sex, country, city, alert, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, c.get('principal').clinicId, f.full_name, f.full_name_norm, f.phone, f.email, f.birth_date, f.sex, f.country, f.city, f.alert, f.notes, toDb(c.get('now'))])
  return c.json({ id }, 201)
})

patientRoutes.patch('/:id', requires('patients.edit'), async (c) => {
  const f = await parse(c, true), keys = Object.keys(f)
  if (!keys.length) throw bad('nothing to update')
  const n = await c.get('db').run(`UPDATE patient SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND clinic_id = ?`, [...keys.map((k) => f[k]), c.req.param('id'), c.get('principal').clinicId])
  if (n !== 1) throw new ApiError(404, 'not_found', 'Not found')
  return c.body(null, 204)
})

// Patients are archived, never deleted (clinical and billing history refer to them).
patientRoutes.post('/:id/archive', requires('patients.manage'), async (c) => {
  const n = await c.get('db').run('UPDATE patient SET archived_at = ? WHERE id = ? AND clinic_id = ? AND archived_at IS NULL', [toDb(c.get('now')), c.req.param('id'), c.get('principal').clinicId])
  if (n !== 1) throw new ApiError(404, 'not_found', 'Not found')
  return c.body(null, 204)
})
