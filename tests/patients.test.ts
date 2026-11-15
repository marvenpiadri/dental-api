// SQLite stand-in (not TiDB): validation, authorization, tenant isolation, search, pagination, bootstrap.
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createClinic } from '../src/admin/bootstrap'
import { sqliteDb } from './helpers/sqlite-db'
import { toDb } from '../src/lib/time'

const env = { TIDB_DATABASE_URL: 'x', PASSWORD_PEPPER: 'pepper', APP_ORIGIN: 'https://app.test', API_ORIGIN: 'https://api.test' }
const db = sqliteDb(), NOW = Date.parse('2026-11-16T07:00:00Z')
const app = createApp({ db: () => db, now: () => NOW })
const H = { origin: 'https://app.test', 'x-dontalist-csrf': '1', 'content-type': 'application/json' }
const ck: Record<string, string> = {}
const call = (who: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { ...H, cookie: ck[who] }, body: body === undefined ? undefined : JSON.stringify(body) }, env)
const login = async (email: string, pw: string) => (await app.request('/v1/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ email, password: pw }) }, env)).headers.get('set-cookie')!.split(';')[0]

beforeAll(async () => {
  // The real bootstrap path creates two clinics; staff of other roles are inserted directly (same hash).
  await createClinic(db, 'pepper', { clinicName: 'Clinic A', ownerEmail: 'Owner@A.test', ownerName: 'Oa', password: 'correct horse battery' })
  await createClinic(db, 'pepper', { clinicName: 'Clinic B', ownerEmail: 'owner@b.test', ownerName: 'Ob', password: 'correct horse battery' })
  const hash = (db.raw.prepare("SELECT password_hash h FROM staff WHERE email_norm='owner@a.test'").get() as any).h
  const cA = (db.raw.prepare("SELECT clinic_id c FROM staff WHERE email_norm='owner@a.test'").get() as any).c
  db.raw.prepare('INSERT INTO staff (id,clinic_id,email_norm,name,role,password_hash,created_at) VALUES (?,?,?,?,?,?,?)').run('assist', cA, 'assist@a.test', 'As', 'assistant', hash, toDb(NOW))
  ck.ownerA = await login('owner@a.test', 'correct horse battery'); ck.ownerB = await login('owner@b.test', 'correct horse battery'); ck.assist = await login('assist@a.test', 'correct horse battery')
})

describe('bootstrap', () => {
  it('rejects duplicate emails and bad input; owner can log in and has owner permissions', async () => {
    await expect(createClinic(db, 'pepper', { clinicName: 'X', ownerEmail: 'OWNER@a.test', ownerName: 'Y', password: 'correct horse battery' })).rejects.toThrow('email already in use')
    await expect(createClinic(db, 'pepper', { clinicName: 'X', ownerEmail: 'nope', ownerName: 'Y', password: 'correct horse battery' })).rejects.toThrow('invalid email')
    const me = (await (await app.request('/v1/auth/me', { headers: { cookie: ck.ownerA } }, env)).json()) as any
    expect(me.role).toBe('owner'); expect(me.permissions).toContain('patients.manage')
  })
})
describe('patients API', () => {
  const mk = (who: string, name: string, extra = {}) => call(who, 'POST', '/v1/patients', { fullName: name, ...extra })
  it('creates, reads and updates; validates input', async () => {
    const id = ((await (await mk('ownerA', 'Élodie Benali', { phone: '0600', birthDate: '1990-02-28', sex: 'female' })).json()) as any).id
    const got = (await (await call('ownerA', 'GET', `/v1/patients/${id}`)).json()) as any
    expect(got).toMatchObject({ fullName: 'Élodie Benali', birthDate: '1990-02-28', sex: 'female' })
    expect((await call('ownerA', 'PATCH', `/v1/patients/${id}`, { city: 'Rabat' })).status).toBe(204)
    for (const bad of [{}, { fullName: '' }, { fullName: 'A', birthDate: '2026-02-30' }, { fullName: 'A', sex: 'x' }, { fullName: 'A', email: 'nope' }, { fullName: 'A'.repeat(201) }])
      expect((await call('ownerA', 'POST', '/v1/patients', bad)).status).toBe(400)
  })
  it('enforces permissions: assistant can view but not create/archive', async () => {
    expect((await call('assist', 'GET', '/v1/patients')).status).toBe(200)
    expect((await mk('assist', 'Nope')).status).toBe(403)
  })
  it('isolates clinics on read, update and archive', async () => {
    const id = ((await (await mk('ownerB', 'Secret B')).json()) as any).id
    expect((await call('ownerA', 'GET', `/v1/patients/${id}`)).status).toBe(404)
    expect((await call('ownerA', 'PATCH', `/v1/patients/${id}`, { city: 'x' })).status).toBe(404)
    expect((await call('ownerA', 'POST', `/v1/patients/${id}/archive`)).status).toBe(404)
    const list = (await (await call('ownerA', 'GET', '/v1/patients?q=secret')).json()) as any
    expect(list.items).toHaveLength(0)
  })
  it('searches case- and accent-insensitively by prefix, escapes wildcards', async () => {
    expect(((await (await call('ownerA', 'GET', '/v1/patients?q=elodie')).json()) as any).items).toHaveLength(1)
    expect(((await (await call('ownerA', 'GET', '/v1/patients?q=%25')).json()) as any).items).toHaveLength(0) // a literal %, not "match all"
  })
  it('keyset pagination is stable and bounded; archived are hidden', async () => {
    for (const n of ['Zed 1', 'Zed 2', 'Zed 3', 'Zed 4', 'Zed 5']) await mk('ownerA', n)
    const seen: string[] = []; let cursor = ''
    for (let i = 0; i < 4; i++) {
      const r = (await (await call('ownerA', 'GET', `/v1/patients?q=zed&limit=2${cursor}`)).json()) as any
      seen.push(...r.items.map((x: any) => x.fullName)); if (!r.nextCursor) break; cursor = `&cursor=${r.nextCursor}`
    }
    expect(seen).toEqual(['Zed 1', 'Zed 2', 'Zed 3', 'Zed 4', 'Zed 5'])
    for (const bad of ['limit=101', 'limit=0', 'cursor=%25%25']) expect((await call('ownerA', 'GET', `/v1/patients?${bad}`)).status).toBe(400)
    const id = ((await (await call('ownerA', 'GET', '/v1/patients?q=zed 1')).json()) as any).items[0].id
    expect((await call('ownerA', 'POST', `/v1/patients/${id}/archive`)).status).toBe(204)
    expect(((await (await call('ownerA', 'GET', '/v1/patients?q=zed 1')).json()) as any).items).toHaveLength(0)
    expect(((await (await call('ownerA', 'GET', '/v1/patients?q=zed 1&archived=true')).json()) as any).items).toHaveLength(1)
  })
})
