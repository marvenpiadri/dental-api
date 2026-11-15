// SQLite stand-in (not TiDB): clinical sections, chart validation, optimistic versions, append-only exams, plan rules, permissions, isolation.
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createClinic } from '../src/admin/bootstrap'
import { validateChart } from '../src/clinical/chart'
import { sqliteDb } from './helpers/sqlite-db'
import { toDb } from '../src/lib/time'

const env = { TIDB_DATABASE_URL: 'x', PASSWORD_PEPPER: 'pepper', APP_ORIGIN: 'https://app.test', API_ORIGIN: 'https://api.test' }
const db = sqliteDb(), NOW = Date.parse('2026-11-16T07:00:00Z'), PW = 'correct horse battery'
const app = createApp({ db: () => db, now: () => NOW })
const H = { origin: 'https://app.test', 'x-dontalist-csrf': '1', 'content-type': 'application/json' }
const ck: Record<string, string> = {}
const call = (who: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { ...H, cookie: ck[who] }, body: body === undefined ? undefined : JSON.stringify(body) }, env)
const json = async (r: Response) => (await r.json()) as any
const login = async (email: string) => (await app.request('/v1/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ email, password: PW }) }, env)).headers.get('set-cookie')!.split(';')[0]
const chart = (extra: object = {}) => ({ version: '2.22', globals: { wisdomVisible: false, showBase: true, occlusalVisible: false, showHealthyPulp: false, edentulous: false }, teeth: { '11': { note: 'caries' }, '48': {} }, plan: { '11': { x: 1 } }, case: { smoker: true, nested: { a: [1, 2, { b: null }] } }, ...extra })
let pA = '', pB = ''

beforeAll(async () => {
  const a = await createClinic(db, 'pepper', { clinicName: 'A', ownerEmail: 'owner@a.test', ownerName: 'O', password: PW })
  await createClinic(db, 'pepper', { clinicName: 'B', ownerEmail: 'owner@b.test', ownerName: 'Ob', password: PW })
  const hash = (db.raw.prepare("SELECT password_hash h FROM staff WHERE email_norm='owner@a.test'").get() as any).h
  for (const [id, role] of [['dent', 'dentist'], ['assist', 'assistant'], ['rec', 'reception']]) db.raw.prepare('INSERT INTO staff (id,clinic_id,email_norm,name,role,password_hash,created_at) VALUES (?,?,?,?,?,?,?)').run(id, a.clinicId, `${id}@a.test`, id, role, hash, toDb(NOW))
  for (const w of ['owner@a', 'owner@b', 'dent@a', 'assist@a', 'rec@a']) ck[w] = await login(`${w}.test`)
  pA = (await json(await call('owner@a', 'POST', '/v1/patients', { fullName: 'Pat A' }))).id; pB = (await json(await call('owner@b', 'POST', '/v1/patients', { fullName: 'Pat B' }))).id
})

describe('chart validation', () => {
  it('accepts a valid payload and returns it byte-for-byte', () => { const c = chart(); expect(validateChart(c).json).toBe(JSON.stringify(c)) })
  it.each([[null], [[]], ['x'], [{ ...chart(), version: 'two' }], [{ ...chart(), teeth: [] }], [chart({ teeth: { '99': {} } })], [chart({ teeth: { '11': 'caries' } })], [chart({ plan: { '11': [] } })], [chart({ globals: { showBase: 'yes' } })]])('rejects %j', (bad) => expect(() => validateChart(bad)).toThrow())
  it('rejects oversized payloads', () => expect(() => validateChart(chart({ case: 'x'.repeat(600_000) }))).toThrow(/too large/))
})
describe('working chart', () => {
  it('round-trips without loss and uses an optimistic version', async () => {
    expect((await json(await call('dent@a', 'GET', `/v1/patients/${pA}/chart`))).chart).toBeNull()
    const c = chart(); expect((await json(await call('dent@a', 'PUT', `/v1/patients/${pA}/chart`, { expectedVersion: 0, chart: c }))).version).toBe(1)
    expect((await json(await call('dent@a', 'GET', `/v1/patients/${pA}/chart`))).chart).toEqual(c)
    expect((await call('dent@a', 'PUT', `/v1/patients/${pA}/chart`, { expectedVersion: 0, chart: c })).status).toBe(409) // first-save race
    expect((await call('dent@a', 'PUT', `/v1/patients/${pA}/chart`, { expectedVersion: 5, chart: c })).status).toBe(409)
    expect((await json(await call('assist@a', 'PUT', `/v1/patients/${pA}/chart`, { expectedVersion: 1, chart: chart({ teeth: { '21': {} } }) }))).version).toBe(2)
    expect((await call('dent@a', 'PUT', `/v1/patients/${pA}/chart`, { expectedVersion: 2, chart: { version: '2.22' } })).status).toBe(422)
  })
})
describe('medical history', () => {
  it('saves with versions; reception has no clinical access; another clinic is isolated', async () => {
    const m = { conditions: ['diabetes'], allergies: 'penicillin', medications: 'metformin' }
    expect((await json(await call('dent@a', 'GET', `/v1/patients/${pA}/medical`))).version).toBe(0)
    expect((await call('dent@a', 'PUT', `/v1/patients/${pA}/medical`, { expectedVersion: 0, ...m })).status).toBe(200)
    expect(await json(await call('assist@a', 'GET', `/v1/patients/${pA}/medical`))).toMatchObject({ ...m, version: 1 })
    expect((await call('dent@a', 'PUT', `/v1/patients/${pA}/medical`, { expectedVersion: 0, ...m })).status).toBe(409)
    expect((await call('rec@a', 'GET', `/v1/patients/${pA}/medical`)).status).toBe(403)
    expect((await call('owner@a', 'GET', `/v1/patients/${pB}/medical`)).status).toBe(404)
    expect((await call('dent@a', 'PUT', `/v1/patients/${pA}/medical`, { expectedVersion: 1, conditions: 'x' })).status).toBe(400)
  })
})
describe('examinations', () => {
  it('are append-only snapshots, listed without chart bodies, voided with a reason', async () => {
    const e1 = (await json(await call('dent@a', 'POST', `/v1/patients/${pA}/exams`, { note: 'first', chart: chart(), at: '2026-11-01T09:00:00Z' }))).id
    await call('dent@a', 'POST', `/v1/patients/${pA}/exams`, { note: 'second', chart: chart(), at: '2026-11-10T09:00:00Z' })
    const l = await json(await call('dent@a', 'GET', `/v1/patients/${pA}/exams?limit=1`)); expect(l.items[0].note).toBe('second'); expect(l.items[0].chart).toBeUndefined(); expect(l.nextCursor).toBeTruthy()
    expect((await json(await call('dent@a', 'GET', `/v1/patients/${pA}/exams?limit=1&cursor=${l.nextCursor}`))).items[0].note).toBe('first')
    expect((await json(await call('dent@a', 'GET', `/v1/exams/${e1}`))).chart).toEqual(chart())
    expect((await call('assist@a', 'POST', `/v1/exams/${e1}/void`, { reason: 'x' })).status).toBe(403) // assistant cannot void
    expect((await call('dent@a', 'POST', `/v1/exams/${e1}/void`, {})).status).toBe(400)
    expect((await call('dent@a', 'POST', `/v1/exams/${e1}/void`, { reason: 'wrong patient' })).status).toBe(204)
    expect((await json(await call('dent@a', 'GET', `/v1/exams/${e1}`))).voidReason).toBe('wrong patient')
    expect((await call('dent@a', 'PATCH', `/v1/exams/${e1}`, {})).status).toBe(404) // there is no edit endpoint
    expect((await call('owner@b', 'GET', `/v1/exams/${e1}`)).status).toBe(404)
    expect((await call('dent@a', 'POST', `/v1/patients/${pA}/exams`, { chart: chart(), dentistId: 'not-mine' })).status).toBe(404)
    expect((await call('dent@a', 'POST', `/v1/patients/${pA}/exams`, { chart: { teeth: {} } })).status).toBe(422)
  })
})
describe('treatment plan', () => {
  it('plans, edits while planned, freezes once done, and keeps exact prices', async () => {
    const id = (await json(await call('dent@a', 'POST', `/v1/patients/${pA}/plan`, { tooth: '16', procedure: 'crown', name: 'Crown', price: '1500.50' }))).id
    expect((await call('dent@a', 'PATCH', `/v1/plan/${id}`, { price: 1600 })).status).toBe(204)
    expect((await call('dent@a', 'PATCH', `/v1/plan/${id}`, { name: 'Ceramic crown' })).status).toBe(204)
    const mid = (await json(await call('dent@a', 'GET', `/v1/patients/${pA}/plan`))).items[0]; expect(mid).toMatchObject({ tooth: '16', name: 'Ceramic crown', price: '1600.00', status: 'planned', currency: 'MAD' }) // tooth untouched by the name patch
    expect((await call('dent@a', 'PATCH', `/v1/plan/${id}`, { status: 'done' })).status).toBe(204)
    const done = (await json(await call('dent@a', 'GET', `/v1/patients/${pA}/plan?status=done`))).items[0]; expect(done.date).toBe('2026-11-16'); expect(done.doneAt).toBeTruthy()
    expect((await call('dent@a', 'PATCH', `/v1/plan/${id}`, { price: 1 })).status).toBe(409)
    expect((await call('dent@a', 'DELETE', `/v1/plan/${id}`)).status).toBe(409)
  })
  it('validates input, deletes planned items, paginates, and isolates clinics', async () => {
    for (const bad of [{ procedure: 'x', price: '1.234' }, { procedure: 'x', price: -1 }, { procedure: 'x', price: 1, tooth: '99' }, { price: 1 }, { procedure: 'x', price: 1, quadrant: 2 }]) expect((await call('dent@a', 'POST', `/v1/patients/${pA}/plan`, bad)).status).toBe(400)
    const ids: string[] = []; for (let i = 0; i < 3; i++) ids.push((await json(await call('dent@a', 'POST', `/v1/patients/${pA}/plan`, { procedure: `p${i}`, price: 10 }))).id)
    expect((await call('dent@a', 'DELETE', `/v1/plan/${ids[0]}`)).status).toBe(204)
    const seen: string[] = []; let cur = ''
    for (let i = 0; i < 5; i++) { const r = await json(await call('dent@a', 'GET', `/v1/patients/${pA}/plan?status=planned&limit=1${cur}`)); seen.push(...r.items.map((x: any) => x.procedure)); if (!r.nextCursor) break; cur = `&cursor=${r.nextCursor}` }
    expect([...seen].sort()).toEqual(['p1', 'p2'])
    expect((await call('owner@b', 'PATCH', `/v1/plan/${ids[1]}`, { price: 5 })).status).toBe(404)
    expect((await call('owner@b', 'POST', `/v1/patients/${pA}/plan`, { procedure: 'x', price: 1 })).status).toBe(404)
    expect((await call('rec@a', 'GET', `/v1/patients/${pA}/plan`)).status).toBe(403)
  })
})
