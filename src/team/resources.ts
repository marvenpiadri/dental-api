import { Hono } from 'hono'
import { ApiError } from '../http/errors'
import { authenticate, requires } from '../http/middleware'
import type { AppEnv } from '../http/context'
import { newId } from '../lib/ids'
import { toDb } from '../lib/time'

/** Chairs and dentist profiles: the calendar's resources. Read with appointments.view, change with settings.edit. Archived, never deleted (appointments refer to them). */
export const resourceRoutes = new Hono<AppEnv>()
resourceRoutes.use('*', authenticate)
resourceRoutes.onError((e, c) => { if (e instanceof ApiError) return c.json({ error: { code: e.code, message: e.message }, requestId: c.get('requestId') }, e.status); throw e })
const bad = (m = 'Invalid request') => new ApiError(400, 'bad_request', m)
const str = (v: unknown, max: number, required = false): string | null => { if (v === undefined || v === null || v === '') { if (required) throw bad(); return null } if (typeof v !== 'string' || v.length > max) throw bad(); return v.trim() }
const color = (v: unknown) => { const s = str(v, 16); if (s && !/^#[0-9a-fA-F]{3,8}$/.test(s)) throw bad('Invalid colour'); return s }
const body = async (c: { req: { json: () => Promise<unknown> } }) => { const b = await c.req.json().catch(() => null); if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad(); return b as Record<string, unknown> }

const KINDS = {
  chairs: { table: 'chair', cols: ['name', 'color'] as const, parse: (b: Record<string, unknown>, partial: boolean) => ({ ...(!partial || b.name !== undefined ? { name: str(b.name, 100, true) } : {}), ...(!partial || b.color !== undefined ? { color: color(b.color) } : {}) }), out: (r: any) => ({ id: r.id, name: r.name, color: r.color ?? null }) },
  dentists: { table: 'dentist_profile', cols: ['name', 'specialty', 'color', 'phone', 'email', 'registration'] as const,
    parse: (b: Record<string, unknown>, partial: boolean) => { const o: Record<string, string | null> = {}
      if (!partial || b.name !== undefined) o.name = str(b.name, 200, true)
      for (const [k, max] of [['specialty', 100], ['phone', 40], ['email', 254], ['registration', 64]] as const) if (!partial || b[k] !== undefined) o[k] = str(b[k], max)
      if (!partial || b.color !== undefined) o.color = color(b.color); return o },
    out: (r: any) => ({ id: r.id, name: r.name, specialty: r.specialty ?? null, color: r.color ?? null, phone: r.phone ?? null, email: r.email ?? null, registration: r.registration ?? null }) },
}
for (const [path, k] of Object.entries(KINDS)) {
  resourceRoutes.get(`/${path}`, requires('appointments.view'), async (c) => {
    const rows = await c.get('db').rows(`SELECT id, ${k.cols.join(', ')} FROM ${k.table} WHERE clinic_id = ? AND archived_at IS NULL ORDER BY name, id LIMIT 200`, [c.get('principal').clinicId])
    return c.json({ items: rows.map(k.out) })
  })
  resourceRoutes.post(`/${path}`, requires('settings.edit'), async (c) => {
    const f = k.parse(await body(c), false) as Record<string, string | null>, id = newId(), keys = Object.keys(f)
    await c.get('db').run(`INSERT INTO ${k.table} (id, clinic_id, ${keys.join(', ')}) VALUES (?, ?, ${keys.map(() => '?').join(', ')})`, [id, c.get('principal').clinicId, ...keys.map((x) => f[x])])
    return c.json({ id }, 201)
  })
  resourceRoutes.patch(`/${path}/:id`, requires('settings.edit'), async (c) => {
    const f = k.parse(await body(c), true) as Record<string, string | null>, keys = Object.keys(f)
    if (!keys.length) throw bad('nothing to update')
    const n = await c.get('db').run(`UPDATE ${k.table} SET ${keys.map((x) => `${x} = ?`).join(', ')} WHERE id = ? AND clinic_id = ?`, [...keys.map((x) => f[x]), c.req.param('id'), c.get('principal').clinicId])
    if (n !== 1) throw new ApiError(404, 'not_found', 'Not found'); return c.body(null, 204)
  })
  resourceRoutes.post(`/${path}/:id/archive`, requires('settings.edit'), async (c) => {
    const n = await c.get('db').run(`UPDATE ${k.table} SET archived_at = ? WHERE id = ? AND clinic_id = ? AND archived_at IS NULL`, [toDb(c.get('now')), c.req.param('id'), c.get('principal').clinicId])
    if (n !== 1) throw new ApiError(404, 'not_found', 'Not found'); return c.body(null, 204)
  })
}
