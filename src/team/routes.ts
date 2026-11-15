import { Hono } from 'hono'
import { ApiError } from '../http/errors'
import { authenticate, requires } from '../http/middleware'
import type { AppEnv } from '../http/context'
import { ACTIONS, AREAS, ROLES, OWNER_ONLY, canManageRole, type Permission, type Role } from '../auth/permissions'
import { hashPassword } from '../auth/password'
import { validPassword } from '../auth/password'
import { newId } from '../lib/ids'
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

type S = { id: string; name: string; email_norm: string; role: Role; job_title: string | null; suspended_at: string | null; suspended_reason: string | null }
const COLS = 'id, name, email_norm, role, job_title, suspended_at, suspended_reason'
const view = (s: S, o: { permission: string; kind: string }[]) => ({ id: s.id, name: s.name, email: s.email_norm, role: s.role, jobTitle: s.job_title, suspended: !!s.suspended_at, suspendedReason: s.suspended_reason,
  extra: o.filter((x) => x.kind === 'extra').map((x) => x.permission), removed: o.filter((x) => x.kind === 'removed').map((x) => x.permission) })

teamRoutes.get('/', requires('team.view'), async (c) => {
  const db = c.get('db'), id = c.get('principal').clinicId
  const staff = await db.rows<S>(`SELECT ${COLS} FROM staff WHERE clinic_id = ? ORDER BY name, id LIMIT 200`, [id]) // a clinic is one location: a short list
  const ov = await db.rows<{ staff_id: string; permission: string; kind: string }>('SELECT staff_id, permission, kind FROM staff_permission WHERE clinic_id = ? LIMIT 5000', [id])
  return c.json({ items: staff.map((s) => view(s, ov.filter((o) => o.staff_id === s.id))) })
})

async function target(c: any, id: string): Promise<S> {
  const [s] = await c.get('db').rows(`SELECT ${COLS} FROM staff WHERE id = ? AND clinic_id = ?`, [id, c.get('principal').clinicId]); if (!s) throw notFound(); return s
}
const owners = async (c: any, except?: string) => Number((await c.get('db').rows("SELECT COUNT(*) AS n FROM staff WHERE clinic_id = ? AND role = 'owner' AND suspended_at IS NULL" + (except ? ' AND id <> ?' : ''), except ? [c.get('principal').clinicId, except] : [c.get('principal').clinicId]))[0].n)

teamRoutes.post('/', requires('team.create'), async (c) => {
  const b = await body(c), p = c.get('principal'), r = role(b.role)
  if (!canManageRole(p, r)) throw new ApiError(403, 'forbidden', 'Not allowed')
  const email = str(b.email, 254, true)!.toLowerCase(), name = str(b.name, 200, true)!
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Invalid email')
  if (typeof b.password !== 'string' || !validPassword(b.password)) throw bad('Password must be 12 to 200 characters')
  const db = c.get('db')
  if ((await db.rows('SELECT id FROM staff WHERE email_norm = ?', [email])).length) throw new ApiError(409, 'email_in_use', 'Email already in use')
  const id = newId()
  await db.run('INSERT INTO staff (id, clinic_id, email_norm, name, role, job_title, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, p.clinicId, email, name, r, str(b.jobTitle, 100), await hashPassword(b.password, c.env.PASSWORD_PEPPER), toDb(c.get('now'))])
  await db.run('INSERT INTO audit_event (id, clinic_id, staff_id, action, target_type, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [newId(), p.clinicId, p.staffId, 'staff.added', 'staff', id, r, toDb(c.get('now'))])
  return c.json({ id }, 201)
})

teamRoutes.patch('/:id', requires('team.edit'), async (c) => {
  const b = await body(c), p = c.get('principal'), t = await target(c, c.req.param('id')), db = c.get('db')
  if (!canManageRole(p, t.role)) throw new ApiError(403, 'forbidden', 'Not allowed')
  const sets: string[] = [], args: unknown[] = []
  if (b.name !== undefined) { sets.push('name = ?'); args.push(str(b.name, 200, true)) }
  if (b.jobTitle !== undefined) { sets.push('job_title = ?'); args.push(str(b.jobTitle, 100)) }
  let demotes = false
  if (b.role !== undefined) {
    const r = role(b.role); if (!canManageRole(p, r)) throw new ApiError(403, 'forbidden', 'Not allowed')
    if (t.role === 'owner' && r !== 'owner') { if ((await owners(c, t.id)) < 1) throw new ApiError(409, 'last_owner', 'The clinic needs at least one active owner'); demotes = true }
    sets.push('role = ?'); args.push(r)
  }
  if (!sets.length) throw bad('nothing to update')
  await db.run(`UPDATE staff SET ${sets.join(', ')} WHERE id = ? AND clinic_id = ?`, [...args, t.id, p.clinicId])
  if (demotes && (await owners(c)) < 1) { await db.run("UPDATE staff SET role = 'owner' WHERE id = ? AND clinic_id = ?", [t.id, p.clinicId]); throw new ApiError(409, 'last_owner', 'The clinic needs at least one active owner') } // lost a race with another demotion
  await db.run('INSERT INTO audit_event (id, clinic_id, staff_id, action, target_type, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [newId(), p.clinicId, p.staffId, 'staff.updated', 'staff', t.id, b.role ? String(b.role) : null, toDb(c.get('now'))])
  return c.body(null, 204)
})

// Owner-only-permission rules: those can never be granted, whatever is sent.
teamRoutes.put('/:id/permissions', requires('team.manage'), async (c) => {
  const b = await body(c), p = c.get('principal'), t = await target(c, c.req.param('id')), db = c.get('db')
  if (t.role === 'owner' || !canManageRole(p, t.role)) throw new ApiError(403, 'forbidden', 'Not allowed')
  const extra = perms(b.extra ?? []).filter((x) => !OWNER_ONLY.includes(x)), removed = perms(b.removed ?? [])
  await db.run('DELETE FROM staff_permission WHERE clinic_id = ? AND staff_id = ?', [p.clinicId, t.id])
  for (const [list, kind] of [[extra, 'extra'], [removed, 'removed']] as const)
    if (list.length) await db.run(`INSERT INTO staff_permission (clinic_id, staff_id, permission, kind) VALUES ${list.map(() => '(?, ?, ?, ?)').join(', ')}`, list.flatMap((x) => [p.clinicId, t.id, x, kind]))
  await db.run('INSERT INTO audit_event (id, clinic_id, staff_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [newId(), p.clinicId, p.staffId, 'staff.permissions', 'staff', t.id, toDb(c.get('now'))])
  return c.body(null, 204)
})

// Suspending keeps the history and ends every session at once.
teamRoutes.post('/:id/suspend', requires('team.manage'), async (c) => {
  const b = await body(c), p = c.get('principal'), t = await target(c, c.req.param('id')), db = c.get('db')
  if (!canManageRole(p, t.role)) throw new ApiError(403, 'forbidden', 'Not allowed')
  if (t.role === 'owner' && (await owners(c, t.id)) < 1) throw new ApiError(409, 'last_owner', 'The clinic needs at least one active owner')
  await db.run('UPDATE staff SET suspended_at = ?, suspended_reason = ? WHERE id = ? AND clinic_id = ?', [toDb(c.get('now')), str(b.reason, 500), t.id, p.clinicId])
  await db.run('UPDATE auth_session SET revoked_at = ? WHERE staff_id = ? AND revoked_at IS NULL', [toDb(c.get('now')), t.id])
  if (t.role === 'owner' && (await owners(c)) < 1) { await db.run('UPDATE staff SET suspended_at = NULL, suspended_reason = NULL WHERE id = ? AND clinic_id = ?', [t.id, p.clinicId]); throw new ApiError(409, 'last_owner', 'The clinic needs at least one active owner') }
  await db.run('INSERT INTO audit_event (id, clinic_id, staff_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [newId(), p.clinicId, p.staffId, 'staff.suspended', 'staff', t.id, toDb(c.get('now'))])
  return c.body(null, 204)
})
teamRoutes.post('/:id/reactivate', requires('team.manage'), async (c) => {
  const p = c.get('principal'), t = await target(c, c.req.param('id'))
  if (!canManageRole(p, t.role)) throw new ApiError(403, 'forbidden', 'Not allowed')
  await c.get('db').run('UPDATE staff SET suspended_at = NULL, suspended_reason = NULL, failed_logins = 0, locked_until = NULL WHERE id = ? AND clinic_id = ?', [t.id, p.clinicId])
  return c.body(null, 204)
})
