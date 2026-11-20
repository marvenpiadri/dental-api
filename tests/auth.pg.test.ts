// Real PostgreSQL: login, sessions, lockout, CSRF/CORS, error hygiene.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createClinic } from '../src/admin/bootstrap'
import { testDb } from './pg/db'
import type { PgDb } from '../src/db/client'

const PW = 'correct horse battery'
const env = { PASSWORD_PEPPER: 'pepper', APP_ORIGIN: 'https://app.test', API_ORIGIN: 'https://api.test' }
let db: PgDb, drop: () => Promise<void>, app: ReturnType<typeof createApp>
let clock = Date.parse('2026-11-15T08:00:00Z')
const H = { origin: 'https://app.test', 'x-dontalist-csrf': '1', 'content-type': 'application/json' }
const post = (path: string, body?: unknown, extra: Record<string, string> = {}) => app.request(path, { method: 'POST', headers: { ...H, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) }, env)
const login = (email: string, password = PW) => post('/v1/auth/login', { email, password })
const cookieOf = (r: Response) => r.headers.get('set-cookie')!.split(';')[0]
const me = (ck: string) => app.request('/v1/auth/me', { headers: { cookie: ck } }, env)

beforeAll(async () => {
  ({ db, drop } = await testDb()); app = createApp({ db: () => db, now: () => clock })
  const A = await createClinic(db, 'pepper', { clinicName: 'A', ownerEmail: 'owner@x.test', ownerName: 'Owner', password: PW }, clock)
  await createClinic(db, 'pepper', { clinicName: 'B', ownerEmail: 'ownerb@x.test', ownerName: 'OwnerB', password: PW }, clock)
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
    expect(u.h).toMatch(/^pbkdf2\$/); expect(u.h).not.toContain(PW)
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
