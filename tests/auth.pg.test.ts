// Real PostgreSQL: login, sessions, lockout, CSRF/CORS, error hygiene.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createClinic } from '../src/admin/bootstrap'
import { testDb } from './pg/db'
import type { PgDb } from '../src/db/client'
import { testPasswords } from './pg/harness'

const PW = 'correct horse battery'
const env = { PASSWORD_PEPPER: 'pepper', APP_ORIGIN: 'https://app.test', API_ORIGIN: 'https://api.test' }
const passwords = testPasswords()
let db: PgDb, drop: () => Promise<void>, app: ReturnType<typeof createApp>
let clock = Date.parse('2026-11-15T08:00:00Z')
const H = { origin: 'https://app.test', 'x-dontalist-csrf': '1', 'content-type': 'application/json' }
const post = (path: string, body?: unknown, extra: Record<string, string> = {}) => app.request(path, { method: 'POST', headers: { ...H, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) }, env)
const login = (email: string, password = PW) => post('/v1/auth/login', { email, password })
const cookieOf = (r: Response) => r.headers.get('set-cookie')!.split(';')[0]
const me = (ck: string) => app.request('/v1/auth/me', { headers: { cookie: ck } }, env)

beforeAll(async () => {
  ({ db, drop } = await testDb()); app = createApp({ db: () => db, now: () => clock, passwords: () => passwords })
  const A = await createClinic(db, passwords, { clinicName: 'A', ownerEmail: 'owner@x.test', ownerName: 'Owner', password: PW }, clock)
  await createClinic(db, passwords, { clinicName: 'B', ownerEmail: 'ownerb@x.test', ownerName: 'OwnerB', password: PW }, clock)
  const hash = (await db.rows<{ h: string }>("SELECT password_hash h FROM staff WHERE email_norm = 'owner@x.test'"))[0].h
  await db.run("INSERT INTO staff (id,clinic_id,email_norm,name,role,password_hash,created_at) VALUES ($1,$2,'rec@x.test','Rec','reception',$3,now())", [crypto.randomUUID(), A.clinicId, hash])
})
afterAll(async () => { await drop() })

describe('auth', () => {
  it('logs in with a host-only __Host- HttpOnly cookie and serves /me with permissions', async () => {
    const r = await login('Rec@x.test'); expect(r.status).toBe(200)
    const sc = r.headers.get('set-cookie')!
    expect(sc).toMatch(/^__Host-dl_session=/); expect(sc).toMatch(/HttpOnly/); expect(sc).toMatch(/Secure/); expect(sc).not.toMatch(/Domain=/)
    const j = await (await me(cookieOf(r))).json() as any
    expect(j.role).toBe('reception'); expect(j.permissions).toContain('appointments.create'); expect(j.permissions).not.toContain('billing.void')
  })
  it('stores a hash, never the password, and only the hash of the session token', async () => {
    const [u] = await db.rows<{ h: string }>("SELECT password_hash h FROM staff WHERE email_norm = 'rec@x.test'")
    expect(u.h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/); expect(u.h).not.toContain(PW)
    const r = await login('rec@x.test'); const token = cookieOf(r).split('=')[1]
    expect(await db.rows('SELECT 1 FROM auth_session WHERE token_hash = $1', [token])).toHaveLength(0)
  })
  it('rejects bad credentials identically for unknown and wrong-password accounts', async () => {
    const a = await login('rec@x.test', 'wrong password!!'), b = await login('nobody@x.test')
    expect(a.status).toBe(401); expect(b.status).toBe(401)
    const strip = async (r: Response) => { const j = await r.json() as any; delete j.requestId; return j }
    expect(await strip(a)).toEqual(await strip(b))
  })
  it('locks after 5 failures, then recovers after the lock', async () => {
    for (let i = 0; i < 5; i++) await login('ownerb@x.test', 'bad bad bad bad')
    expect((await login('ownerB@x.test')).status).toBe(429)
    clock += 16 * 60_000
    expect((await login('ownerB@x.test')).status).toBe(200)
  })
  it('requires Origin + CSRF header on mutations; CORS allows only the configured origin', async () => {
    expect((await app.request('/v1/auth/login', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }, env)).status).toBe(403)
    expect((await app.request('/v1/auth/login', { method: 'POST', body: '{}', headers: { ...H, origin: 'https://evil.test' } }, env)).status).toBe(403)
    const ok = await app.request('/health', { headers: { origin: 'https://app.test' } }, env), no = await app.request('/health', { headers: { origin: 'https://evil.test' } }, env)
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.test'); expect(no.headers.get('access-control-allow-origin')).toBeNull()
  })
  it('expires idle sessions and revokes on logout', async () => {
    const ck = cookieOf(await login('owner@x.test'))
    expect((await me(ck)).status).toBe(200)
    expect((await post('/v1/auth/logout', undefined, { cookie: ck })).status).toBe(204)
    expect((await me(ck)).status).toBe(401)
    const ck2 = cookieOf(await login('owner@x.test')); clock += 3 * 3600_000
    expect((await me(ck2)).status).toBe(401)
  })
  it('suspended staff cannot use an existing session', async () => {
    const ck = cookieOf(await login('rec@x.test'))
    await db.run("UPDATE staff SET suspended_at = now() WHERE email_norm = 'rec@x.test'")
    expect((await me(ck)).status).toBe(401)
  })
  it('writes an audit event for each login', async () => {
    expect(Number((await db.rows<{ n: string }>("SELECT count(*) n FROM audit_event WHERE action = 'auth.login'"))[0].n)).toBeGreaterThan(3)
  })
  it('does not leak internals on errors', async () => {
    const bad = createApp({ db: () => { throw new Error('postgres://user:secret@host') } })
    const r = await bad.request('/v1/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ email: 'a@b.c', password: 'x' }) }, env); const t = await r.text()
    expect(r.status).toBe(503); expect(t).not.toContain('secret')
  })
})

// ---- the password service: legacy upgrade, outages, timeouts, forged calls. The service is the real handler (real Argon2id, real HMAC check).
const LEGACY = 'pbkdf2$1000x2$dIpvPhGsxX28kUECQRjO2A$jLx_8DG2DyF38xGgik33ihW6qMIG_fMEQBLsHrzouKc' // "correct horse battery", pepper "pepper"
const hashOf = async (email: string) => (await db.rows<{ h: string }>('SELECT password_hash h FROM staff WHERE email_norm = $1', [email]))[0].h
const failures = async (email: string) => Number((await db.rows<{ n: string }>('SELECT failed_logins n FROM staff WHERE email_norm = $1', [email]))[0].n)
async function user(email: string, hash?: string) {
  const [{ id }] = await db.rows<{ id: string }>("SELECT id FROM clinic LIMIT 1")
  await db.run("INSERT INTO staff (id,clinic_id,email_norm,name,role,password_hash,created_at) VALUES ($1,$2,$3,'U','reception',$4,now())", [crypto.randomUUID(), id, email, hash ?? await passwords.hash(PW)])
}
/** An app wired to the given password service, plus a call recorder in front of the real in-process service. */
function appWith(svc?: Parameters<typeof testPasswords>[0], opts: { pepper?: string | null; unconfigured?: boolean } = {}) {
  const calls: string[] = []
  const real = testPasswords().constructor && ((u: any, i: any) => testPasswordsFetch(u, i))
  const service = svc ?? { fetch: (u: any, i: any) => { calls.push(new URL(u).pathname); return real(u, i) } }
  const a = opts.unconfigured ? createApp({ db: () => db, now: () => clock }) : createApp({ db: () => db, now: () => clock, passwords: () => testPasswords(service) })
  const e = { ...env, ...(opts.pepper === null ? { PASSWORD_PEPPER: undefined } : {}) }
  const send = (path: string, body?: unknown, extra: Record<string, string> = {}) => a.request(path, { method: 'POST', headers: { ...H, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) }, e)
  return { calls, send, login: (email: string, password = PW) => send('/v1/auth/login', { email, password }) }
}
import { handle } from '../password-service/src/handler'
import { SERVICE_SECRET } from './pg/harness'
const testPasswordsFetch = (u: string, i: RequestInit) => handle(new Request(u, i), { HASH_SECRET: SERVICE_SECRET })

describe('password service: legacy hashes', () => {
  it('logs a legacy user in and upgrades the hash to Argon2id; later logins use the new hash', async () => {
    await user('legacy1@x.test', LEGACY); const a = appWith()
    expect((await a.login('legacy1@x.test')).status).toBe(200)
    expect(await hashOf('legacy1@x.test')).toMatch(/^\$argon2id\$/); expect(a.calls).toEqual(['/verify', '/hash'].slice(1)) // legacy check ran locally; only the new hash needed the service
    a.calls.length = 0
    expect((await a.login('legacy1@x.test')).status).toBe(200); expect(a.calls).toEqual(['/verify'])
    expect((await a.login('legacy1@x.test', 'wrong password here')).status).toBe(401)
  })
  it('a wrong password on a legacy account fails, counts as a failure and changes nothing', async () => {
    await user('legacy2@x.test', LEGACY); const a = appWith()
    expect((await a.login('legacy2@x.test', 'not the password!!')).status).toBe(401)
    expect(await hashOf('legacy2@x.test')).toBe(LEGACY); expect(await failures('legacy2@x.test')).toBe(1); expect(a.calls).toEqual([])
  })
  it('without PASSWORD_PEPPER a legacy hash can never verify (and is not upgraded)', async () => {
    await user('legacy3@x.test', LEGACY); const a = appWith(undefined, { pepper: null })
    expect((await a.login('legacy3@x.test')).status).toBe(401); expect(await hashOf('legacy3@x.test')).toBe(LEGACY)
  })
  it('the upgrade never overwrites a password changed in the meantime', async () => {
    await user('legacy4@x.test', LEGACY)
    const a = appWith({ fetch: async (u: any, i: any) => { await db.run("UPDATE staff SET password_hash = 'changed-meanwhile' WHERE email_norm = 'legacy4@x.test'"); return testPasswordsFetch(u, i) } })
    expect((await a.login('legacy4@x.test')).status).toBe(200); expect(await hashOf('legacy4@x.test')).toBe('changed-meanwhile')
  })
  it('if the service is down the legacy login still works and the hash stays legacy for the next try', async () => {
    await user('legacy5@x.test', LEGACY); const a = appWith({ fetch: async () => { throw new Error('down') } })
    expect((await a.login('legacy5@x.test')).status).toBe(200); expect(await hashOf('legacy5@x.test')).toBe(LEGACY)
  })
  it('legacy accounts work even when no service is configured', async () => {
    await user('legacy6@x.test', LEGACY); const a = appWith(undefined, { unconfigured: true })
    expect((await a.login('legacy6@x.test')).status).toBe(200); expect(await hashOf('legacy6@x.test')).toBe(LEGACY)
  })
})

describe('password service: availability fails closed, never as a wrong password', () => {
  const outages: [string, Parameters<typeof testPasswords>[0]][] = [
    ['connection refused', { fetch: async () => { throw new TypeError('fetch failed') } }],
    ['HTTP 500', { fetch: async () => new Response('boom', { status: 500 }) }],
    ['HTTP 503 busy', { fetch: async () => new Response('{}', { status: 503 }) }],
    ['garbage body', { fetch: async () => new Response('<html>', { status: 200 }) }],
    ['wrong shape', { fetch: async () => Response.json({ valid: 'yes' }) }],
    ['timeout', { timeoutMs: 40, fetch: (_u: any, i: any) => new Promise((_r, rej) => i.signal.addEventListener('abort', () => rej(new Error('aborted')))) }],
  ]
  for (const [name, svc] of outages) it(`${name}: login answers 503, locks nobody, creates no session`, async () => {
    const email = `down-${name.replace(/\W/g, '').toLowerCase()}@x.test`; await user(email); const a = appWith(svc); const before = Number((await db.rows<{ n: string }>('SELECT count(*) n FROM auth_session'))[0].n)
    for (let i = 0; i < 7; i++) { const r = await a.login(email); const t = await r.text(); expect(r.status).toBe(503); expect(t).toContain('unavailable'); expect(t).not.toContain('password.test'); expect(r.headers.get('set-cookie')).toBeNull() }
    expect(await failures(email)).toBe(0); expect(Number((await db.rows<{ n: string }>('SELECT count(*) n FROM auth_session'))[0].n)).toBe(before)
    expect((await appWith().login(email)).status).toBe(200) // back up: same account signs in, not locked
  })
  it('an unknown e-mail during an outage is also 503 (it makes the same service call)', async () => {
    expect((await appWith({ fetch: async () => { throw new Error('down') } }).login('ghost@x.test')).status).toBe(503)
  })
  it('no service configured: Argon2id accounts cannot sign in, change passwords or be created', async () => {
    await user('nocfg@x.test'); const a = appWith(undefined, { unconfigured: true })
    expect((await a.login('nocfg@x.test')).status).toBe(503)
  })
  it('a service that rejects our signature (wrong secret) is an outage, not an auth result', async () => {
    await user('forged@x.test'); const a = appWith({ fetch: (u: any, i: any) => handle(new Request(u, i), { HASH_SECRET: 'a-different-secret-a-different-secret!' }) })
    expect((await a.login('forged@x.test')).status).toBe(503)
  })
})

describe('password service: work equalization, lockout, suspension', () => {
  it('unknown accounts cost the same service call as known ones, and answer the same 401', async () => {
    await user('known@x.test'); const a = appWith()
    expect((await a.login('known@x.test', 'wrong wrong wrong')).status).toBe(401); expect((await a.login('who@x.test', 'wrong wrong wrong')).status).toBe(401)
    expect(a.calls).toEqual(['/verify', '/verify'])
  })
  it('a locked account answers 429 even with the right password; a suspended one 401', async () => {
    await user('locked@x.test'); await user('susp@x.test'); const a = appWith()
    for (let i = 0; i < 5; i++) await a.login('locked@x.test', 'bad bad bad bad')
    expect((await a.login('locked@x.test')).status).toBe(429)
    await db.run("UPDATE staff SET suspended_at = now() WHERE email_norm = 'susp@x.test'")
    expect((await a.login('susp@x.test')).status).toBe(401)
  })
})

describe('password service: password change', () => {
  const change = (a: ReturnType<typeof appWith>, ck: string, current: string, next: string) => a.send('/v1/auth/password', { current, next }, { cookie: ck })
  it('verifies the current password, stores a fresh Argon2id hash, revokes other sessions', async () => {
    await user('chg@x.test'); const a = appWith(); const ck = cookieOf(await a.login('chg@x.test')), other = cookieOf(await a.login('chg@x.test')); const old = await hashOf('chg@x.test')
    expect((await change(a, ck, 'not the current one', 'brand new password 1')).status).toBe(401); expect(await hashOf('chg@x.test')).toBe(old)
    expect((await change(a, ck, PW, 'short')).status).toBe(400)
    expect((await change(a, ck, PW, 'brand new password 1')).status).toBe(204)
    const now = await hashOf('chg@x.test'); expect(now).toMatch(/^\$argon2id\$/); expect(now).not.toBe(old); expect(now).not.toContain('brand new')
    expect((await a.login('chg@x.test', PW)).status).toBe(401); expect((await a.login('chg@x.test', 'brand new password 1')).status).toBe(200)
    expect((await me(ck)).status).toBe(200); expect((await me(other)).status).toBe(401)
  })
  it('a legacy user can change their password and ends up on Argon2id', async () => {
    await user('chgleg@x.test', LEGACY); const a = appWith(); const ck = cookieOf(await a.login('chgleg@x.test'))
    expect((await change(a, ck, PW, 'another new password!')).status).toBe(204); expect(await hashOf('chgleg@x.test')).toMatch(/^\$argon2id\$/)
  })
  it('an outage during the change is a 503 and leaves the password untouched', async () => {
    await user('chgdown@x.test'); const ck = cookieOf(await appWith().login('chgdown@x.test')); const old = await hashOf('chgdown@x.test')
    const down = appWith({ fetch: async () => { throw new Error('down') } })
    expect((await change(down, ck, PW, 'brand new password 2')).status).toBe(503); expect(await hashOf('chgdown@x.test')).toBe(old)
  })
})
