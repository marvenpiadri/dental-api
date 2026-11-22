import { Hono } from 'hono'
import { ApiError } from '../http/errors'
import { authenticate, requires } from '../http/middleware'
import type { AppEnv } from '../http/context'
import { DuplicateKeyError, type Db } from '../db/client'
import { ACTIONS, AREAS, ROLES, OWNER_ONLY, canManageRole, type Permission, type Role } from '../auth/permissions'
import { validPassword } from '../auth/password'
import { isUuid, newId } from '../lib/ids'
import { toDb } from '../lib/time'

export const teamRoutes = new Hono<AppEnv>()
teamRoutes.use('*', authenticate)
teamRoutes.onError((e, c) => { if (e instanceof ApiError) return c.json({ error: { code: e.code, message: e.message }, requestId: c.get('requestId') }, e.status); throw e })

const bad = (m = 'Invalid request') => new ApiError(400, 'bad_request', m)
const notFound = () => new ApiError(404, 'not_found', 'Not found')
const body = async (c: { req: { json: () => Promise<unknown> } }) => { const b = await c.req.json().catch(() => null); if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad(); return b as Record<string, unknown> }
const str = (v: unknown, max: number, required = false): string | null => { if (v === undefined || v === null || v === '') { if (required) throw bad(); return null } if (typeof v !== 'string' || v.length > max) throw bad(); return v.trim() }
const role = (v: unknown): Role => { if (typeof v !== 'string' || !ROLES.includes(v as Role)) throw bad('Invalid role'); return v as Role }
const ALL = new Set(AREAS.flatMap((a) => ACTIONS.map((x) => `${a}.${x}`)))
const perms = (v: unknown): Permission[] => { if (!Array.isArray(v) || v.length > 100 || v.some((p) => typeof p !== 'string' || !ALL.has(p))) throw bad('Invalid permissions'); return [...new Set(v as Permission[])] }

type S = { id: string; name: string; email_norm: string; role: Role; job_title: string | null; photo_file_id: string | null; suspended_at: string | null; suspended_reason: string | null }
const COLS = 'id, name, email_norm, role, job_title, photo_file_id, suspended_at, suspended_reason'
const view = (s: S, o: { permission: string; kind: string }[]) => ({ id: s.id, name: s.name, email: s.email_norm, role: s.role, jobTitle: s.job_title, photoFileId: s.photo_file_id, suspended: !!s.suspended_at, suspendedReason: s.suspended_reason,
  extra: o.filter((x) => x.kind === 'extra').map((x) => x.permission), removed: o.filter((x) => x.kind === 'removed').map((x) => x.permission) })
const audit = (db: Db, p: { clinicId: string; staffId: string }, at: number, action: string, target: string, detail?: object) =>
  db.run('INSERT INTO audit_event (id, clinic_id, staff_id, action, target_type, target_id, detail, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [newId(), p.clinicId, p.staffId, action, 'staff', target, detail ? JSON.stringify(detail) : null, toDb(at)])

teamRoutes.get('/', requires('team.view'), async (c) => {
  const db = c.get('db'), id = c.get('principal').clinicId
  const staff = await db.rows<S>(`SELECT ${COLS} FROM staff WHERE clinic_id = $1 ORDER BY name, id LIMIT 200`, [id]) // a clinic is one location: a short list
  const ov = await db.rows<{ staff_id: string; permission: string; kind: string }>('SELECT staff_id, permission, kind FROM staff_permission WHERE clinic_id = $1 LIMIT 5000', [id])
  return c.json({ items: staff.map((s) => view(s, ov.filter((o) => o.staff_id === s.id))) })
})

async function target(db: Db, clinicId: string, id: string, lock = false): Promise<S> {
  if (!isUuid(id)) throw notFound()
  const [s] = await db.rows<S>(`SELECT ${COLS} FROM staff WHERE id = $1 AND clinic_id = $2${lock ? ' FOR UPDATE' : ''}`, [id, clinicId]); if (!s) throw notFound(); return s
}
/** Locks the clinic's active owners, so two concurrent demotions/suspensions cannot both pass the "last owner" check. */
const otherOwners = async (db: Db, clinicId: string, except: string) =>
  (await db.rows('SELECT id FROM staff WHERE clinic_id = $1 AND role = \'owner\' AND suspended_at IS NULL AND id <> $2 FOR UPDATE', [clinicId, except])).length
const lastOwner = () => new ApiError(409, 'last_owner', 'The clinic needs at least one active owner')

teamRoutes.post('/', requires('team.create'), async (c) => {
  const b = await body(c), p = c.get('principal'), r = role(b.role)
  if (!canManageRole(p, r)) throw new ApiError(403, 'forbidden', 'Not allowed')
  const email = str(b.email, 254, true)!.toLowerCase(), name = str(b.name, 200, true)!
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Invalid email')
  if (typeof b.password !== 'string' || !validPassword(b.password)) throw bad('Password must be 12 to 200 characters')
  const id = newId(), hash = await c.get('passwords').hash(b.password)
  try {
    await c.get('db').tx(async (db) => {
      await db.run('INSERT INTO staff (id, clinic_id, email_norm, name, role, job_title, password_hash, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [id, p.clinicId, email, name, r, str(b.jobTitle, 100), hash, toDb(c.get('now'))])
      await audit(db, p, c.get('now'), 'staff.added', id, { role: r })
    })
  } catch (e) { if (e instanceof DuplicateKeyError) throw new ApiError(409, 'email_in_use', 'Email already in use'); throw e }
  return c.json({ id }, 201)
})

teamRoutes.patch('/:id', requires('team.edit'), async (c) => {
  const b = await body(c), p = c.get('principal')
  await c.get('db').tx(async (db) => {
    const t = await target(db, p.clinicId, c.req.param('id'), true)
    if (!canManageRole(p, t.role)) throw new ApiError(403, 'forbidden', 'Not allowed')
    const sets: string[] = [], args: unknown[] = []
    const set = (col: string, v: unknown) => { args.push(v); sets.push(`${col} = $${args.length}`) }
    if (b.name !== undefined) set('name', str(b.name, 200, true))
    if (b.jobTitle !== undefined) set('job_title', str(b.jobTitle, 100))
    if (b.role !== undefined) {
      const r = role(b.role); if (!canManageRole(p, r)) throw new ApiError(403, 'forbidden', 'Not allowed')
      if (t.role === 'owner' && r !== 'owner' && !t.suspended_at && (await otherOwners(db, p.clinicId, t.id)) < 1) throw lastOwner()
      set('role', r)
    }
    if (!sets.length) throw bad('nothing to update')
    await db.run(`UPDATE staff SET ${sets.join(', ')} WHERE id = $${args.length + 1} AND clinic_id = $${args.length + 2}`, [...args, t.id, p.clinicId])
    await audit(db, p, c.get('now'), 'staff.updated', t.id, b.role ? { role: String(b.role) } : undefined)
  })
  return c.body(null, 204)
})

// Owner-only-permission rules: those can never be granted, whatever is sent.
teamRoutes.put('/:id/permissions', requires('team.manage'), async (c) => {
  const b = await body(c), p = c.get('principal')
  const extra = perms(b.extra ?? []).filter((x) => !OWNER_ONLY.includes(x)), removed = perms(b.removed ?? [])
  await c.get('db').tx(async (db) => {
    const t = await target(db, p.clinicId, c.req.param('id'), true)
    if (t.role === 'owner' || !canManageRole(p, t.role)) throw new ApiError(403, 'forbidden', 'Not allowed')
    await db.run('DELETE FROM staff_permission WHERE clinic_id = $1 AND staff_id = $2', [p.clinicId, t.id])
    for (const [list, kind] of [[extra, 'extra'], [removed, 'removed']] as const)
      if (list.length) await db.run('INSERT INTO staff_permission (clinic_id, staff_id, permission, kind) SELECT $1, $2, x, $3 FROM unnest($4::text[]) AS x', [p.clinicId, t.id, kind, list])
    await audit(db, p, c.get('now'), 'staff.permissions', t.id)
  })
  return c.body(null, 204)
})

// Suspending keeps the history and ends every session at once.
teamRoutes.post('/:id/suspend', requires('team.manage'), async (c) => {
  const b = await body(c), p = c.get('principal'), reason = str(b.reason, 500)
  await c.get('db').tx(async (db) => {
    const t = await target(db, p.clinicId, c.req.param('id'), true)
    if (!canManageRole(p, t.role)) throw new ApiError(403, 'forbidden', 'Not allowed')
    if (t.role === 'owner' && !t.suspended_at && (await otherOwners(db, p.clinicId, t.id)) < 1) throw lastOwner()
    await db.run('UPDATE staff SET suspended_at = $1, suspended_reason = $2 WHERE id = $3 AND clinic_id = $4', [toDb(c.get('now')), reason, t.id, p.clinicId])
    await db.run('UPDATE auth_session SET revoked_at = $1 WHERE staff_id = $2 AND revoked_at IS NULL', [toDb(c.get('now')), t.id])
    await audit(db, p, c.get('now'), 'staff.suspended', t.id)
  })
  return c.body(null, 204)
})
teamRoutes.post('/:id/reactivate', requires('team.manage'), async (c) => {
  const p = c.get('principal'), t = await target(c.get('db'), p.clinicId, c.req.param('id'))
  if (!canManageRole(p, t.role)) throw new ApiError(403, 'forbidden', 'Not allowed')
  await c.get('db').run('UPDATE staff SET suspended_at = NULL, suspended_reason = NULL, failed_logins = 0, locked_until = NULL WHERE id = $1 AND clinic_id = $2', [t.id, p.clinicId])
  return c.body(null, 204)
})
