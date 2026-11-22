// Real PostgreSQL: staff management, last-owner protection (incl. a concurrency race), permission overrides, isolation, password change.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createClinic } from '../src/admin/bootstrap'
import { testPasswords } from './pg/harness'
import { testDb } from './pg/db'
import type { PgDb } from '../src/db/client'

const env = { PASSWORD_PEPPER: 'pepper', APP_ORIGIN: 'https://app.test', API_ORIGIN: 'https://api.test' }
const NOW = Date.parse('2026-11-16T07:00:00Z'), PW = 'correct horse battery'
const passwords = testPasswords()
let db: PgDb, drop: () => Promise<void>, app: ReturnType<typeof createApp>
const H = { origin: 'https://app.test', 'x-dontalist-csrf': '1', 'content-type': 'application/json' }
const ck: Record<string, string> = {}, ids: Record<string, string> = {}
const call = (who: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { ...H, cookie: ck[who] }, body: body === undefined ? undefined : JSON.stringify(body) }, env)
const json = async (r: Response) => (await r.json()) as any
const login = async (email: string, pw = PW) => (await app.request('/v1/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ email, password: pw }) }, env)).headers.get('set-cookie')?.split(';')[0] ?? ''

beforeAll(async () => {
  ({ db, drop } = await testDb()); app = createApp({ db: () => db, now: () => NOW, passwords: () => passwords })
  await createClinic(db, passwords, { clinicName: 'A', ownerEmail: 'owner@a.test', ownerName: 'Owner', password: PW }, NOW)
  await createClinic(db, passwords, { clinicName: 'B', ownerEmail: 'owner@b.test', ownerName: 'OwnerB', password: PW }, NOW)
  ck.owner = await login('owner@a.test'); ck.ownerB = await login('owner@b.test')
  for (const [k, role] of [['admin', 'admin'], ['rec', 'reception'], ['dent', 'dentist']]) {
    ids[k] = (await json(await call('owner', 'POST', '/v1/staff', { name: k, email: `${k}@a.test`, role, password: PW }))).id; ck[k] = await login(`${k}@a.test`)
  }
  ids.owner = (await json(await call('owner', 'GET', '/v1/staff'))).items.find((s: any) => s.email === 'owner@a.test').id
})
afterAll(async () => { await drop() })

describe('staff management', () => {
  it('lists only the clinic, and only for team.view holders', async () => {
    expect((await json(await call('owner', 'GET', '/v1/staff'))).items).toHaveLength(4)
    expect((await call('rec', 'GET', '/v1/staff')).status).toBe(403)
    expect((await json(await call('ownerB', 'GET', '/v1/staff'))).items).toHaveLength(1)
  })
  it('validates creation and rejects duplicate emails', async () => {
    for (const bad of [{ name: 'x', email: 'nope', role: 'dentist', password: PW }, { name: 'x', email: 'x@a.test', role: 'dentist', password: 'short' }, { name: 'x', email: 'x@a.test', role: 'boss', password: PW }]) expect((await call('owner', 'POST', '/v1/staff', bad)).status).toBe(400)
    expect((await call('owner', 'POST', '/v1/staff', { name: 'd', email: 'REC@a.test', role: 'dentist', password: PW })).status).toBe(409)
    expect((await call('ownerB', 'POST', '/v1/staff', { name: 'd', email: 'rec@a.test', role: 'dentist', password: PW })).status).toBe(409) // e-mail is unique across clinics
  })
  it('an admin cannot create or change owners; only an owner can', async () => {
    expect((await call('admin', 'POST', '/v1/staff', { name: 'o2', email: 'o2@a.test', role: 'owner', password: PW })).status).toBe(403)
    expect((await call('admin', 'PATCH', `/v1/staff/${ids.owner}`, { name: 'hacked' })).status).toBe(403)
    expect((await call('admin', 'PATCH', `/v1/staff/${ids.rec}`, { role: 'owner' })).status).toBe(403)
    expect((await call('admin', 'PATCH', `/v1/staff/${ids.rec}`, { jobTitle: 'Front desk' })).status).toBe(204)
  })
  it('the last active owner cannot be demoted or suspended', async () => {
    expect((await call('owner', 'PATCH', `/v1/staff/${ids.owner}`, { role: 'admin' })).status).toBe(409)
    expect((await call('owner', 'POST', `/v1/staff/${ids.owner}/suspend`, {})).status).toBe(409)
    expect((await json(await call('owner', 'GET', '/v1/auth/me'))).role).toBe('owner')
  })
  it('two owners demoting each other at the same moment: exactly one succeeds, an owner remains', async () => {
    const o2 = (await json(await call('owner', 'POST', '/v1/staff', { name: 'o2', email: 'o2@a.test', role: 'owner', password: PW }))).id
    ck.o2 = await login('o2@a.test')
    const rs = await Promise.all([call('owner', 'PATCH', `/v1/staff/${o2}`, { role: 'admin' }), call('o2', 'PATCH', `/v1/staff/${ids.owner}`, { role: 'admin' })])
    const st = rs.map((r) => r.status).sort()
    expect(st[0]).toBe(204); expect([401, 403, 409]).toContain(st[1]) // the loser is refused: last_owner, or already demoted by the winner
    expect(Number((await db.rows<{ n: string }>("SELECT count(*) n FROM staff WHERE role = 'owner' AND clinic_id = (SELECT clinic_id FROM staff WHERE id = $1)", [ids.owner]))[0].n)).toBe(1)
  })
  it('permission overrides apply immediately; owner-only permissions can never be granted', async () => {
    const owner = (await db.rows<{ email_norm: string }>("SELECT email_norm FROM staff WHERE role = 'owner' AND email_norm LIKE '%@a.test'"))[0].email_norm
    ck.owner = await login(owner); const oid = (await json(await call('owner', 'GET', '/v1/staff'))).items.find((s: any) => s.email === owner).id; ids.owner = oid
    expect((await json(await call('rec', 'GET', '/v1/auth/me'))).permissions).toContain('patients.create')
    expect((await call('owner', 'PUT', `/v1/staff/${ids.rec}/permissions`, { removed: ['patients.create'], extra: ['reports.view', 'profile.edit', 'team.void'] })).status).toBe(204)
    const m = await json(await call('rec', 'GET', '/v1/auth/me'))
    expect(m.permissions).not.toContain('patients.create'); expect(m.permissions).toContain('reports.view'); expect(m.permissions).not.toContain('profile.edit'); expect(m.permissions).not.toContain('team.void')
    expect((await call('owner', 'PUT', `/v1/staff/${ids.rec}/permissions`, { extra: ['bogus.perm'] })).status).toBe(400)
    expect((await call('admin', 'PUT', `/v1/staff/${ids.owner}/permissions`, { extra: [] })).status).toBe(403)
  })
  it('suspending ends sessions at once and blocks login; reactivating restores access', async () => {
    expect((await call('owner', 'POST', `/v1/staff/${ids.dent}/suspend`, { reason: 'leave' })).status).toBe(204)
    expect((await call('dent', 'GET', '/v1/auth/me')).status).toBe(401)
    expect(await login('dent@a.test')).toBe('')
    expect((await call('owner', 'POST', `/v1/staff/${ids.dent}/reactivate`)).status).toBe(204)
    expect(await login('dent@a.test')).not.toBe('')
  })
  it("another clinic's staff are invisible; malformed ids are 404, not 500", async () => {
    const other = (await json(await call('ownerB', 'GET', '/v1/staff'))).items[0].id
    for (const [m, p] of [['PATCH', ''], ['POST', '/suspend'], ['PUT', '/permissions']] as const) expect((await call('owner', m, `/v1/staff/${other}${p}`, { name: 'x' })).status).toBe(404)
    expect((await call('owner', 'PATCH', '/v1/staff/not-a-uuid', { name: 'x' })).status).toBe(404)
  })
  it('records audit events for changes', async () => {
    const r = await db.rows<{ action: string }>("SELECT DISTINCT action FROM audit_event WHERE action LIKE 'staff.%'")
    expect(r.map((x) => x.action)).toEqual(expect.arrayContaining(['staff.added', 'staff.updated', 'staff.permissions', 'staff.suspended']))
  })
})
describe('password change', () => {
  it('needs the current password, validates the new one, and signs out other sessions', async () => {
    const second = await login('admin@a.test')
    expect((await call('admin', 'POST', '/v1/auth/password', { current: 'wrong wrong wrong', next: 'another long password' })).status).toBe(401)
    expect((await call('admin', 'POST', '/v1/auth/password', { current: PW, next: 'short' })).status).toBe(400)
    expect((await call('admin', 'POST', '/v1/auth/password', { current: PW, next: 'another long password' })).status).toBe(204)
    ck.second = second
    expect((await call('second', 'GET', '/v1/auth/me')).status).toBe(401)
    expect((await call('admin', 'GET', '/v1/auth/me')).status).toBe(200)
    expect(await login('admin@a.test')).toBe(''); expect(await login('admin@a.test', 'another long password')).not.toBe('')
  })
})
