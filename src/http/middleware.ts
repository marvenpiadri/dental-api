import { createMiddleware } from 'hono/factory'
import { getCookie } from 'hono/cookie'
import { cors } from 'hono/cors'
import { bodyLimit } from 'hono/body-limit'
import { secureHeaders } from 'hono/secure-headers'
import { loadConfig } from '../config'
import { effective, type Permission, type Role } from '../auth/permissions'
import { sha256Hex } from '../lib/ids'
import { fromDb, toDb } from '../lib/time'
import { ApiError, fail } from './errors'
import type { Db } from '../db/client'
import { unconfiguredStore } from '../files/store'
import type { AppEnv, Deps } from './context'

export const UPLOAD_PATH = /^\/v1\/patients\/[^/]+\/documents$/
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
/** Sent by our own frontend on every mutation; browsers will not add it to a cross-site form post. */
export const CSRF_HEADER = 'x-dontalist-csrf'

export const base = (deps: Deps) => createMiddleware<AppEnv>(async (c, next) => {
  c.set('requestId', crypto.randomUUID())
  c.set('now', (deps.now ?? Date.now)())
  try { c.set('config', loadConfig(c.env)); // Lazy: /health and config errors must not need database credentials.
    let real: Db | undefined; const get = () => (real ??= deps.db(c.env))
    c.set('db', { rows: (q, p) => get().rows(q, p), run: (q, p) => get().run(q, p) })
    c.set('files', deps.files ? deps.files(c.env) : unconfiguredStore) } catch (e) {
    console.error('configuration error', c.get('requestId'), e instanceof Error ? e.message : e)
    return fail(c, new ApiError(503, 'unavailable', 'Service unavailable'))
  }
  c.header('X-Request-Id', c.get('requestId'))
  c.header('Cache-Control', 'no-store')
  await next()
})

export const security = [
  secureHeaders({ crossOriginResourcePolicy: 'same-site', referrerPolicy: 'no-referrer' }),
  // Exact-origin allow-list from configuration; credentials on; no wildcard.
  createMiddleware<AppEnv>((c, next) =>
    cors({ origin: (o) => (c.get('config').corsOrigins.includes(o) ? o : null), credentials: true, allowHeaders: ['Content-Type', CSRF_HEADER], allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], maxAge: 600 })(c, next)),
  // Cookie-authenticated mutations must come from an allowed origin AND carry the CSRF header.
  createMiddleware<AppEnv>(async (c, next) => {
    if (UNSAFE.has(c.req.method)) {
      const origin = c.req.header('origin')
      if (!origin || !c.get('config').corsOrigins.includes(origin) || c.req.header(CSRF_HEADER) !== '1') return fail(c, new ApiError(403, 'csrf', 'Request rejected'))
    }
    await next()
  }),
  // Streams are counted, so a lying Content-Length cannot bypass this. Per-route larger limits (file upload) are set on those routes.
  // The one route that carries file bytes sets its own, larger, streamed limit; every other body is capped at 64 KB.
  createMiddleware<AppEnv>((c, next) => c.req.method === 'POST' && UPLOAD_PATH.test(c.req.path) ? next()
    : bodyLimit({ maxSize: 64 * 1024, onError: (cc) => fail(cc, new ApiError(413, 'too_large', 'Request too large')) })(c, next)),
]

type SessionRow = { token_hash: string; clinic_id: string; staff_id: string; last_seen_at: string; expires_at: string; name: string; role: Role; suspended_at: string | null }

export const authenticate = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get('principal')) return next() // already authenticated by an earlier mount of this middleware
  const { cookie, session } = c.get('config'), now = c.get('now'), db = c.get('db')
  const token = getCookie(c, cookie.name)
  if (!token || token.length > 128) return fail(c, new ApiError(401, 'unauthenticated', 'Sign in required'))
  const hash = await sha256Hex(token)
  const [s] = await db.rows<SessionRow>(
    `SELECT s.token_hash, s.clinic_id, s.staff_id, s.last_seen_at, s.expires_at, t.name, t.role, t.suspended_at
       FROM auth_session s JOIN staff t ON t.id = s.staff_id AND t.clinic_id = s.clinic_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL`, [hash])
  if (!s || s.suspended_at || fromDb(s.expires_at) <= now || fromDb(s.last_seen_at) + session.idleMs <= now)
    return fail(c, new ApiError(401, 'unauthenticated', 'Sign in required'))
  const overrides = await db.rows<{ permission: Permission; kind: string }>(
    'SELECT permission, kind FROM staff_permission WHERE clinic_id = ? AND staff_id = ?', [s.clinic_id, s.staff_id])
  const perms = effective({ role: s.role, extra: overrides.filter((o) => o.kind === 'extra').map((o) => o.permission), removed: overrides.filter((o) => o.kind === 'removed').map((o) => o.permission) })
  // Slide the idle window at most once a minute to avoid a write on every request.
  if (now - fromDb(s.last_seen_at) > 60_000) await db.run('UPDATE auth_session SET last_seen_at = ? WHERE token_hash = ?', [toDb(now), hash])
  c.set('principal', { staffId: s.staff_id, clinicId: s.clinic_id, name: s.name, role: s.role, permissions: perms, sessionHash: hash })
  await next()
})

/** Authorization is enforced here on the server; the Angular guards are only UX. */
export const requires = (permission: Permission) => createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get('principal').permissions.has(permission)) return fail(c, new ApiError(403, 'forbidden', 'Not allowed'))
  await next()
})
