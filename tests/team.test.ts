// SQLite stand-in (not TiDB): team management, last-owner protection, permission overrides, session revocation, chairs/dentists, password change.
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createClinic } from '../src/admin/bootstrap'
import { sqliteDb } from './helpers/sqlite-db'

const env = { TIDB_DATABASE_URL: 'x', PASSWORD_PEPPER: 'pepper', APP_ORIGIN: 'https://app.test', API_ORIGIN: 'https://api.test' }
const db = sqliteDb(), NOW = Date.parse('2026-11-16T07:00:00Z'), PW = 'correct horse battery'
const app = createApp({ db: () => db, now: () => NOW })
const H = { origin: 'https://app.test', 'x-dontalist-csrf': '1', 'content-type': 'application/json' }
const ck: Record<string, string> = {}
const call = (who: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { ...H, cookie: ck[who] }, body: body === undefined ? undefined : JSON.stringify(body) }, env)
const json = async (r: Response) => (await r.json()) as any
const login = async (email: string, pw = PW) => { const r = await app.request('/v1/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ email, password: pw }) }, env); return r.headers.get('set-cookie')?.split(';')[0] ?? '' }
const ids: Record<string, string> = {}

beforeAll(async () => {
  await createClinic(db, 'pepper', { clinicName: 'A', ownerEmail: 'owner@a.test', ownerName: 'Owner', password: PW })
  await createClinic(db, 'pepper', { clinicName: 'B', ownerEmail: 'owner@b.test', ownerName: 'OwnerB', password: PW })
  ck.owner = await login('owner@a.test'); ck.ownerB = await login('owner@b.test')
  for (const [k, role] of [['admin', 'admin'], ['rec', 'reception'], ['dent', 'dentist']]) {
    const r = await call('owner', 'POST', '/v1/staff', { name: k, email: `${k}@a.test`, role, password: PW }); ids[k] = (await json(r)).id; ck[k] = await login(`${k}@a.test`)
  }
  ids.owner = (await json(await call('owner', 'GET', '/v1/staff'))).items.find((s: any) => s.email === 'owner@a.test').id
})

describe('staff management', () => {
  it('lists only the clinic, and only for team.view holders', async () => {
    expect((await json(await call('owner', 'GET', '/v1/staff'))).items).toHaveLength(4)
    expect((await call('rec', 'GET', '/v1/staff')).status).toBe(403)
    expect((await json(await call('ownerB', 'GET', '/v1/staff'))).items).toHaveLength(1)
  })
  it('validates creation and rejects duplicate emails', async () => {
    for (const bad of [{ name: 'x', email: 'nope', role: 'dentist', password: PW }, { name: 'x', email: 'x@a.test', role: 'dentist', password: 'short' }, { name: 'x', email: 'x@a.test', role: 'boss', password: PW }]) expect((await call('owner', 'POST', '/v1/staff', bad)).status).toBe(400)
    expect((await call('owner', 'POST', '/v1/staff', { name: 'd', email: 'REC@a.test', role: 'dentist', password: PW })).status).toBe(409)
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
  it('with a second owner, one can be demoted', async () => {
    const o2 = (await json(await call('owner', 'POST', '/v1/staff', { name: 'o2', email: 'o2@a.test', role: 'owner', password: PW }))).id
    expect((await call('owner', 'PATCH', `/v1/staff/${o2}`, { role: 'admin' })).status).toBe(204)
  })
  it('permission overrides apply immediately; owner-only permissions can never be granted', async () => {
    expect((await call('rec', 'POST', '/v1/patients', { fullName: 'P' })).status).toBe(201)
    expect((await call('owner', 'PUT', `/v1/staff/${ids.rec}/permissions`, { removed: ['patients.create'], extra: ['reports.view', 'profile.edit', 'team.void'] })).status).toBe(204)
    expect((await call('rec', 'POST', '/v1/patients', { fullName: 'P2' })).status).toBe(403)
    const me = await json(await call('rec', 'GET', '/v1/auth/me'))
    expect(me.permissions).toContain('reports.view'); expect(me.permissions).not.toContain('profile.edit'); expect(me.permissions).not.toContain('team.void')
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
  it("another clinic's staff are invisible", async () => {
    const other = (await json(await call('ownerB', 'GET', '/v1/staff'))).items[0].id
    for (const [m, p] of [['PATCH', ''], ['POST', '/suspend'], ['PUT', '/permissions']] as const) expect((await call('owner', m, `/v1/staff/${other}${p}`, { name: 'x' })).status).toBe(404)
  })
})
describe('password change', () => {
  it('needs the current password, validates the new one, and signs out other sessions', async () => {
    const second = await login('admin@a.test')
    expect((await call('admin', 'POST', '/v1/auth/password', { current: 'wrong wrong wrong', next: 'another long password' })).status).toBe(401)
    expect((await call('admin', 'POST', '/v1/auth/password', { current: PW, next: 'short' })).status).toBe(400)
    expect((await call('admin', 'POST', '/v1/auth/password', { current: PW, next: 'another long password' })).status).toBe(204)
    ck.second = second
    expect((await call('second', 'GET', '/v1/auth/me')).status).toBe(401) // other session revoked
    expect((await call('admin', 'GET', '/v1/auth/me')).status).toBe(200) // current kept
    expect(await login('admin@a.test')).toBe(''); expect(await login('admin@a.test', 'another long password')).not.toBe('')
  })
})
describe('chairs and dentists', () => {
  it('settings.edit manages them; appointments.view reads; archived are hidden; clinics are isolated', async () => {
    const c1 = await json(await call('owner', 'POST', '/v1/chairs', { name: 'Chair 1', color: '#ff0000' }))
    expect((await call('rec', 'POST', '/v1/chairs', { name: 'x' })).status).toBe(403)
    expect((await call('owner', 'POST', '/v1/chairs', { name: 'x', color: 'red' })).status).toBe(400)
    const d1 = await json(await call('owner', 'POST', '/v1/dentists', { name: 'Dr Z', specialty: 'Ortho', registration: 'R1' }))
    expect((await json(await call('rec', 'GET', '/v1/chairs'))).items.map((x: any) => x.name)).toEqual(['Chair 1'])
    expect((await call('owner', 'PATCH', `/v1/dentists/${d1.id}`, { phone: '0600' })).status).toBe(204)
    expect((await call('ownerB', 'PATCH', `/v1/dentists/${d1.id}`, { phone: 'x' })).status).toBe(404)
    expect((await call('owner', 'POST', `/v1/chairs/${c1.id}/archive`)).status).toBe(204)
    expect((await json(await call('owner', 'GET', '/v1/chairs'))).items).toHaveLength(0)
    expect((await json(await call('ownerB', 'GET', '/v1/dentists'))).items).toHaveLength(0)
  })
})
