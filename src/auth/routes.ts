import { Hono } from 'hono'
import { deleteCookie, setCookie } from 'hono/cookie'
import { hashPassword, needsRehash, validPassword, verifyPassword, dummyHash } from './password'
import { newId, randomToken, sha256Hex } from '../lib/ids'
import { fromDb, toDb } from '../lib/time'
import { ApiError, fail } from '../http/errors'
import { authenticate } from '../http/middleware'
import type { AppEnv } from '../http/context'
import type { Role } from './permissions'

const MAX_FAILURES = 5
const LOCK_MS = 15 * 60_000
type StaffRow = { id: string; clinic_id: string; password_hash: string; failed_logins: number; locked_until: string | null; suspended_at: string | null; role: Role; name: string }

export const authRoutes = new Hono<AppEnv>()

authRoutes.post('/login', async (c) => {
  const bad = () => fail(c, new ApiError(401, 'invalid_credentials', 'E-mail or password is incorrect'))
  let body: { email?: unknown; password?: unknown }
  try { body = await c.req.json() } catch { return fail(c, new ApiError(400, 'bad_request', 'Invalid request')) }
  if (typeof body.email !== 'string' || typeof body.password !== 'string' || body.email.length > 254 || body.password.length > 200)
    return fail(c, new ApiError(400, 'bad_request', 'Invalid request'))
  const db = c.get('db'), now = c.get('now'), cfg = c.get('config')
  const email = body.email.trim().toLowerCase()
  const [u] = await db.rows<StaffRow>('SELECT id, clinic_id, password_hash, failed_logins, locked_until, suspended_at, role, name FROM staff WHERE email_norm = $1', [email])
  // Same work whether or not the account exists, so timing does not reveal accounts.
  const ok = await verifyPassword(body.password, u?.password_hash ?? dummyHash(), c.env.PASSWORD_PEPPER)
  if (u?.locked_until && fromDb(u.locked_until) > now) return fail(c, new ApiError(429, 'locked', 'Too many attempts. Try again later.'))
  if (!u || !ok || u.suspended_at) {
    if (u) await db.run('UPDATE staff SET locked_until = CASE WHEN failed_logins + 1 >= $1 THEN $2::timestamptz ELSE locked_until END, failed_logins = failed_logins + 1 WHERE id = $3', [MAX_FAILURES, toDb(now + LOCK_MS), u.id])
    return bad()
  }
  if (u.failed_logins || u.locked_until) await db.run('UPDATE staff SET failed_logins = 0, locked_until = NULL WHERE id = $1', [u.id])
  if (needsRehash(u.password_hash)) await db.run('UPDATE staff SET password_hash = $1 WHERE id = $2', [await hashPassword(body.password, c.env.PASSWORD_PEPPER), u.id])
  const token = randomToken()
  await db.run('INSERT INTO auth_session (token_hash, clinic_id, staff_id, created_at, last_seen_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [await sha256Hex(token), u.clinic_id, u.id, toDb(now), toDb(now), toDb(now + cfg.session.absoluteMs)])
  await db.run('INSERT INTO audit_event (id, clinic_id, staff_id, action, created_at) VALUES ($1, $2, $3, $4, $5)', [newId(), u.clinic_id, u.id, 'auth.login', toDb(now)])
  setCookie(c, cfg.cookie.name, token, { httpOnly: true, secure: cfg.cookie.secure, sameSite: cfg.cookie.sameSite, path: '/', domain: cfg.cookie.domain, maxAge: Math.floor(cfg.session.absoluteMs / 1000) })
  return c.json({ staff: { id: u.id, name: u.name, role: u.role } })
})

authRoutes.post('/logout', authenticate, async (c) => {
  const cfg = c.get('config')
  await c.get('db').run('UPDATE auth_session SET revoked_at = $1 WHERE token_hash = $2', [toDb(c.get('now')), c.get('principal').sessionHash])
  deleteCookie(c, cfg.cookie.name, { path: '/', domain: cfg.cookie.domain, secure: cfg.cookie.secure })
  return c.body(null, 204)
})

authRoutes.get('/me', authenticate, (c) => {
  const p = c.get('principal')
  return c.json({ id: p.staffId, clinicId: p.clinicId, name: p.name, role: p.role, permissions: [...p.permissions].sort() })
})

/** Self-service password change. Needs the current password, and signs out every OTHER session. */
authRoutes.post('/password', authenticate, async (c) => {
  const b = await c.req.json().catch(() => null) as { current?: unknown; next?: unknown } | null
  if (!b || typeof b.current !== 'string' || typeof b.next !== 'string' || !validPassword(b.next)) return fail(c, new ApiError(400, 'bad_request', 'Password must be 12 to 200 characters'))
  const p = c.get('principal'), db = c.get('db')
  const [u] = await db.rows<{ password_hash: string }>('SELECT password_hash FROM staff WHERE id = $1 AND clinic_id = $2', [p.staffId, p.clinicId])
  if (!u || !(await verifyPassword(b.current, u.password_hash, c.env.PASSWORD_PEPPER))) return fail(c, new ApiError(401, 'invalid_credentials', 'Current password is incorrect'))
  await db.run('UPDATE staff SET password_hash = $1 WHERE id = $2 AND clinic_id = $3', [await hashPassword(b.next, c.env.PASSWORD_PEPPER), p.staffId, p.clinicId])
  await db.run('UPDATE auth_session SET revoked_at = $1 WHERE staff_id = $2 AND revoked_at IS NULL AND token_hash <> $3', [toDb(c.get('now')), p.staffId, p.sessionHash])
  return c.body(null, 204)
})
