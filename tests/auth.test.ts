import { describe, expect, it, beforeAll } from 'vitest'
import { createApp } from '../src/app'
import { hashPassword } from '../src/auth/password'
import { sqliteDb } from './helpers/sqlite-db'
import { toDb } from '../src/lib/time'

const env = { TIDB_DATABASE_URL: 'x', PASSWORD_PEPPER: 'pepper', APP_ORIGIN: 'https://app.test', API_ORIGIN: 'https://api.test' }
const PW = 'correct horse battery'
const db = sqliteDb()
let clock = Date.parse('2026-11-15T08:00:00Z')
const app = createApp({ db: () => db, now: () => clock })
const H = { origin: 'https://app.test', 'x-dontalist-csrf': '1', 'content-type': 'application/json' }
const post = (path: string, body?: unknown, extra: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { ...H, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) }, env)
const login = (email: string, password = PW) => post('/v1/auth/login', { email, password })
const cookieOf = (r: Response) => r.headers.get('set-cookie')!.split(';')[0]

beforeAll(async () => {
  const hash = await hashPassword(PW, 'pepper'), t = toDb(clock)
  for (const c of ['A', 'B']) db.raw.prepare('INSERT INTO clinic (id,name,timezone,created_at) VALUES (?,?,?,?)').run(c, c, 'UTC', t)
  const add = (id: string, clinic: string, role: string) => db.raw.prepare('INSERT INTO staff (id,clinic_id,email_norm,name,role,password_hash,created_at) VALUES (?,?,?,?,?,?,?)').run(id, clinic, `${id.toLowerCase()}@x.test`, id, role, hash, t)
  add('owner', 'A', 'owner'); add('rec', 'A', 'reception'); add('ownerB', 'B', 'owner')
})

describe('auth', () => {
  it('logs in with a host-only __Host- HttpOnly cookie and serves /me with permissions', async () => {
    const r = await login('Rec@x.test')
    expect(r.status).toBe(200)
    const sc = r.headers.get('set-cookie')!
    expect(sc).toMatch(/^__Host-dl_session=/); expect(sc).toMatch(/HttpOnly/); expect(sc).toMatch(/Secure/); expect(sc).not.toMatch(/Domain=/)
    const me = await app.request('/v1/auth/me', { headers: { cookie: cookieOf(r) } }, env)
    const j = await me.json() as any
    expect(j.role).toBe('reception'); expect(j.permissions).toContain('appointments.create'); expect(j.permissions).not.toContain('billing.void')
  })
  it('stores a hash, never the password', () => {
    const [u] = db.raw.prepare("SELECT password_hash h FROM staff WHERE id='rec'").all() as any[]
    expect(u.h).toMatch(/^pbkdf2\$/); expect(u.h).not.toContain(PW)
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
  it('requires Origin + CSRF header on mutations', async () => {
    expect((await app.request('/v1/auth/login', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }, env)).status).toBe(403)
    expect((await app.request('/v1/auth/login', { method: 'POST', body: '{}', headers: { ...H, origin: 'https://evil.test' } }, env)).status).toBe(403)
  })
  it('CORS allows only the configured origin', async () => {
    const ok = await app.request('/health', { headers: { origin: 'https://app.test' } }, env)
    const no = await app.request('/health', { headers: { origin: 'https://evil.test' } }, env)
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.test'); expect(no.headers.get('access-control-allow-origin')).toBeNull()
  })
  it('expires idle sessions and revokes on logout', async () => {
    const r = await login('owner@x.test'); const ck = cookieOf(r)
    expect((await app.request('/v1/auth/me', { headers: { cookie: ck } }, env)).status).toBe(200)
    expect((await post('/v1/auth/logout', undefined, { cookie: ck })).status).toBe(204)
    expect((await app.request('/v1/auth/me', { headers: { cookie: ck } }, env)).status).toBe(401)
    const r2 = await login('owner@x.test'); clock += 3 * 3600_000
    expect((await app.request('/v1/auth/me', { headers: { cookie: cookieOf(r2) } }, env)).status).toBe(401)
  })
  it('suspended staff cannot use an existing session', async () => {
    const r = await login('rec@x.test'); db.raw.prepare("UPDATE staff SET suspended_at='x' WHERE id='rec'").run()
    expect((await app.request('/v1/auth/me', { headers: { cookie: cookieOf(r) } }, env)).status).toBe(401)
  })
  it('does not leak internals on errors', async () => {
    const bad = createApp({ db: () => { throw new Error('mysql://user:secret@host') } })
    const r = await bad.request('/v1/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ email: 'a@b.c', password: 'x' }) }, env); const t = await r.text()
    expect(r.status).toBe(503); expect(t).not.toContain('secret')
  })
})
