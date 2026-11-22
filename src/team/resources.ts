import { Hono } from 'hono'
import { ApiError, fail } from '../http/errors'
import { authenticate, requires } from '../http/middleware'
import type { AppEnv } from '../http/context'
import { isUuid, newId } from '../lib/ids'
import { toDb } from '../lib/time'

/** Chairs and dentist profiles: the calendar's resources. Read with appointments.view, change with settings.edit. Archived, never deleted (appointments refer to them). */
export const resourceRoutes = new Hono<AppEnv>()
resourceRoutes.use('*', authenticate)
resourceRoutes.onError((e, c) => { if (e instanceof ApiError) return fail(c, e); throw e })
const bad = (m = 'Invalid request') => new ApiError(400, 'bad_request', m)
const notFound = () => new ApiError(404, 'not_found', 'Not found')
const str = (v: unknown, max: number, required = false): string | null => { if (v === undefined || v === null || v === '') { if (required) throw bad(); return null } if (typeof v !== 'string' || v.length > max) throw bad(); return v.trim() }
const color = (v: unknown) => { const s = str(v, 16); if (s && !/^#[0-9a-fA-F]{3,8}$/.test(s)) throw bad('Invalid colour'); return s }
const hours = (v: unknown) => {
  if (v === undefined || v === null) return null
  const h = v as { open?: unknown; close?: unknown }, t = /^([01]\d|2[0-3]):[0-5]\d$/
  if (typeof v !== 'object' || Array.isArray(v) || (h.open !== undefined && !t.test(String(h.open))) || (h.close !== undefined && !t.test(String(h.close)))) throw bad('Invalid hours')
  return JSON.stringify({ ...(h.open !== undefined && { open: h.open }), ...(h.close !== undefined && { close: h.close }) })
}
const body = async (c: { req: { json: () => Promise<unknown> } }) => { const b = await c.req.json().catch(() => null); if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad(); return b as Record<string, unknown> }

type Kind = { table: string; cols: readonly string[]; parse: (b: Record<string, unknown>, partial: boolean) => Record<string, unknown>; out: (r: any) => object }
const KINDS: Record<string, Kind> = {
  chairs: { table: 'chair', cols: ['name', 'color'], parse: (b, partial) => ({ ...(!partial || b.name !== undefined ? { name: str(b.name, 100, true) } : {}), ...(!partial || b.color !== undefined ? { color: color(b.color) } : {}) }), out: (r) => ({ id: r.id, name: r.name, color: r.color ?? null }) },
  dentists: { table: 'dentist_profile', cols: ['name', 'specialty', 'color', 'phone', 'email', 'registration', 'hours'],
    parse: (b, partial) => { const o: Record<string, unknown> = {}
      if (!partial || b.name !== undefined) o.name = str(b.name, 200, true)
      for (const [k, max] of [['specialty', 100], ['phone', 40], ['email', 254], ['registration', 64]] as const) if (!partial || b[k] !== undefined) o[k] = str(b[k], max)
      if (!partial || b.color !== undefined) o.color = color(b.color)
      if (!partial || b.hours !== undefined) o.hours = hours(b.hours)
      return o },
    out: (r) => ({ id: r.id, name: r.name, photoFileId: r.photo_file_id ?? null, specialty: r.specialty ?? null, color: r.color ?? null, phone: r.phone ?? null, email: r.email ?? null, registration: r.registration ?? null, hours: r.hours ?? null }) },
}
for (const [path, k] of Object.entries(KINDS)) {
  resourceRoutes.get(`/${path}`, requires('appointments.view'), async (c) => {
    const rows = await c.get('db').rows(`SELECT id, ${k.cols.join(', ')}${k.table === 'dentist_profile' ? ', photo_file_id' : ''} FROM ${k.table} WHERE clinic_id = $1 AND archived_at IS NULL ORDER BY name, id LIMIT 200`, [c.get('principal').clinicId])
    return c.json({ items: rows.map(k.out) })
  })
  resourceRoutes.post(`/${path}`, requires('settings.edit'), async (c) => {
    const f = k.parse(await body(c), false), id = newId(), keys = Object.keys(f), vals = [id, c.get('principal').clinicId, ...keys.map((x) => f[x])]
    await c.get('db').run(`INSERT INTO ${k.table} (id, clinic_id, ${keys.join(', ')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')})`, vals)
    return c.json({ id }, 201)
  })
  resourceRoutes.patch(`/${path}/:id`, requires('settings.edit'), async (c) => {
    const id = c.req.param('id'); if (!isUuid(id)) throw notFound()
    const f = k.parse(await body(c), true), keys = Object.keys(f)
    if (!keys.length) throw bad('nothing to update')
    const n = await c.get('db').run(`UPDATE ${k.table} SET ${keys.map((x, i) => `${x} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1} AND clinic_id = $${keys.length + 2}`, [...keys.map((x) => f[x]), id, c.get('principal').clinicId])
    if (n !== 1) throw notFound(); return c.body(null, 204)
  })
  resourceRoutes.post(`/${path}/:id/archive`, requires('settings.edit'), async (c) => {
    const id = c.req.param('id'); if (!isUuid(id)) throw notFound()
    const n = await c.get('db').run(`UPDATE ${k.table} SET archived_at = $1 WHERE id = $2 AND clinic_id = $3 AND archived_at IS NULL`, [toDb(c.get('now')), id, c.get('principal').clinicId])
    if (n !== 1) throw notFound(); return c.body(null, 204)
  })
}
