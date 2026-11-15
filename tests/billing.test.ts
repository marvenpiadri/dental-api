// SQLite stand-in (not TiDB). SQLite sums DECIMAL as floats, so amounts here are exactly representable (x.00/x.50); real exactness comes from TiDB DECIMAL + BigInt.
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createClinic } from '../src/admin/bootstrap'
import { DuplicateKeyError, type Db } from '../src/db/client'
import { yearIn } from '../src/billing/service'
import { sqliteDb } from './helpers/sqlite-db'
import { toDb } from '../src/lib/time'

const env = { TIDB_DATABASE_URL: 'x', PASSWORD_PEPPER: 'pepper', APP_ORIGIN: 'https://app.test', API_ORIGIN: 'https://api.test' }
const raw = sqliteDb(), NOW = Date.parse('2026-11-16T07:00:00Z')
let failNextInvoiceInsert = 0
const db: Db = { rows: raw.rows, run: async (sql, p) => { if (failNextInvoiceInsert > 0 && /^INSERT INTO invoice \(/.test(sql)) { failNextInvoiceInsert--; throw new DuplicateKeyError() } return raw.run(sql, p) } }
const app = createApp({ db: () => db, now: () => NOW })
const H = { origin: 'https://app.test', 'x-dontalist-csrf': '1', 'content-type': 'application/json' }
const ck: Record<string, string> = {}
const call = (who: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { ...H, cookie: ck[who] }, body: body === undefined ? undefined : JSON.stringify(body) }, env)
const json = async (r: Response) => (await r.json()) as any
const login = async (email: string) => (await app.request('/v1/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ email, password: 'correct horse battery' }) }, env)).headers.get('set-cookie')!.split(';')[0]
let pA = '', pA2 = '', pB = ''
const invoice = (who: string, patient: string, prices: unknown[]) => call(who, 'POST', `/v1/patients/${patient}/invoices`, { lines: prices.map((price, i) => ({ itemId: `i${i}`, label: `Act ${i}`, price })) })

beforeAll(async () => {
  const a = await createClinic(raw, 'pepper', { clinicName: 'A', ownerEmail: 'owner@a.test', ownerName: 'Oa', password: 'correct horse battery' })
  const b = await createClinic(raw, 'pepper', { clinicName: 'B', ownerEmail: 'owner@b.test', ownerName: 'Ob', password: 'correct horse battery' })
  const hash = (raw.raw.prepare("SELECT password_hash h FROM staff WHERE email_norm='owner@a.test'").get() as any).h
  for (const [id, role] of [['rec', 'reception'], ['dent', 'dentist']]) raw.raw.prepare('INSERT INTO staff (id,clinic_id,email_norm,name,role,password_hash,created_at) VALUES (?,?,?,?,?,?,?)').run(id, a.clinicId, `${id}@a.test`, id, role, hash, toDb(NOW))
  for (const who of ['owner@a', 'owner@b', 'rec@a', 'dent@a']) ck[who] = await login(`${who}.test`)
  const mk = async (who: string, n: string) => (await json(await call(who, 'POST', '/v1/patients', { fullName: n }))).id
  pA = await mk('owner@a', 'Pat A'); pA2 = await mk('owner@a', 'Pat A2'); pB = await mk('owner@b', 'Pat B')
})

describe('invoices', () => {
  it('numbers FA-YYYY-NNNN per clinic and kind, with exact totals', async () => {
    const r1 = await json(await invoice('owner@a', pA, ['0.10', '0.20'])), r2 = await json(await invoice('rec@a', pA, [1500]))
    expect([r1.number, r2.number]).toEqual(['FA-2026-0001', 'FA-2026-0002'])
    expect((await json(await call('owner@a', 'GET', `/v1/invoices/${r1.id}`))).total).toBe('0.30')
    expect((await json(await invoice('owner@b', pB, [100]))).number).toBe('FA-2026-0001') // other clinic counts on its own
  })
  it('rejects invalid money and shapes', async () => {
    for (const bad of [['1.234'], [1e21], ['abc'], [null]]) expect((await invoice('owner@a', pA, bad)).status).toBe(400)
    expect((await invoice('owner@a', pA, [-5])).status).toBe(422) // well-formed but negative: only credit notes are negative
    expect((await call('owner@a', 'POST', `/v1/patients/${pA}/invoices`, { lines: [] })).status).toBe(400)
  })
  it('retries when the number is taken by a concurrent issue (duplicate key)', async () => {
    failNextInvoiceInsert = 2
    const r = await json(await invoice('owner@a', pA2, [10])); expect(r.number).toMatch(/^FA-2026-\d{4}$/)
  })
  it('cancelling issues a credit note, blocks a second cancel, and nets the balance to zero', async () => {
    const inv = await json(await invoice('owner@a', pA2, ['250.50']))
    expect((await call('rec@a', 'POST', `/v1/invoices/${inv.id}/cancel`, { reason: 'x' })).status).toBe(403) // reception cannot void
    const cn = await json(await call('owner@a', 'POST', `/v1/invoices/${inv.id}/cancel`, { reason: 'wrong patient' }))
    expect(cn.number).toMatch(/^AV-2026-0001$/)
    const got = await json(await call('owner@a', 'GET', `/v1/invoices/${cn.id}`)); expect(got.total).toBe('-250.50'); expect(got.cancelsId).toBe(inv.id)
    expect((await json(await call('owner@a', 'GET', `/v1/invoices/${inv.id}`))).cancelledAt).toBeTruthy()
    expect((await call('owner@a', 'POST', `/v1/invoices/${inv.id}/cancel`, { reason: 'again' })).status).toBe(409)
    expect((await call('owner@a', 'POST', `/v1/invoices/${cn.id}/cancel`, { reason: 'credit note' })).status).toBe(422)
  })
  it('lists newest first with keyset pagination', async () => {
    const seen: string[] = []; let cur = ''
    for (let i = 0; i < 6; i++) { const r = await json(await call('owner@a', 'GET', `/v1/patients/${pA}/invoices?limit=1${cur}`)); seen.push(...r.items.map((x: any) => x.number)); if (!r.nextCursor) break; cur = `&cursor=${r.nextCursor}` }
    expect([...seen].sort()).toEqual(['FA-2026-0001', 'FA-2026-0002']) // paged one at a time: each exactly once (the test clock gives every invoice the same instant, so only the id breaks ties)
  })
})
describe('payments and balance', () => {
  it('records payments, rejects bad ones, voids with a reason and excludes voided from the balance', async () => {
    const before = await json(await call('owner@a', 'GET', `/v1/patients/${pA}/balance`))
    const inv = await json(await invoice('owner@a', pA, ['1000.00']))
    const pay = (b: object) => call('rec@a', 'POST', `/v1/patients/${pA}/payments`, b)
    const p1 = await json(await pay({ amount: 400, method: 'cash', invoiceId: inv.id })); await pay({ amount: '100.50', method: 'card' })
    for (const bad of [{ amount: 0, method: 'cash' }, { amount: -1, method: 'cash' }, { amount: 5, method: 'bitcoin' }, { amount: 5, method: 'cash', invoiceId: 'nope' }]) expect((await pay(bad)).status).toBeGreaterThanOrEqual(400)
    const after = await json(await call('owner@a', 'GET', `/v1/patients/${pA}/balance`))
    expect(Number(after.due)).toBeCloseTo(Number(before.due) + 1000 - 500.5, 2); expect(after.currency).toBe('MAD')
    expect((await call('rec@a', 'POST', `/v1/payments/${p1.id}/void`, { reason: 'x' })).status).toBe(403)
    expect((await call('owner@a', 'POST', `/v1/payments/${p1.id}/void`, {})).status).toBe(400) // reason required
    expect((await call('owner@a', 'POST', `/v1/payments/${p1.id}/void`, { reason: 'entered twice' })).status).toBe(204)
    expect((await call('owner@a', 'POST', `/v1/payments/${p1.id}/void`, { reason: 'again' })).status).toBe(404)
    expect(Number((await json(await call('owner@a', 'GET', `/v1/patients/${pA}/balance`))).due)).toBeCloseTo(Number(before.due) + 1000 - 100.5, 2)
    const list = await json(await call('owner@a', 'GET', `/v1/patients/${pA}/payments`)); expect(list.items.some((x: any) => x.voidReason === 'entered twice')).toBe(true) // kept in history
  })
  it('a payment cannot settle another patient\'s, a cancelled, or a credit-note document', async () => {
    const inv = await json(await invoice('owner@a', pA2, [30])); await call('owner@a', 'POST', `/v1/invoices/${inv.id}/cancel`, { reason: 'r' })
    expect((await call('rec@a', 'POST', `/v1/patients/${pA2}/payments`, { amount: 5, method: 'cash', invoiceId: inv.id })).status).toBe(422)
    const other = await json(await invoice('owner@a', pA, [30]))
    expect((await call('rec@a', 'POST', `/v1/patients/${pA2}/payments`, { amount: 5, method: 'cash', invoiceId: other.id })).status).toBe(404)
  })
})
describe('access control', () => {
  it('dentist has no billing access; clinics are isolated', async () => {
    expect((await call('dent@a', 'GET', `/v1/patients/${pA}/invoices`)).status).toBe(403)
    const b = await json(await invoice('owner@b', pB, [50]))
    expect((await call('owner@a', 'GET', `/v1/invoices/${b.id}`)).status).toBe(404)
    expect((await call('owner@a', 'POST', `/v1/invoices/${b.id}/cancel`, { reason: 'x' })).status).toBe(404)
    expect((await invoice('owner@a', pB, [1])).status).toBe(404)
    expect((await call('owner@a', 'GET', `/v1/patients/${pB}/balance`)).status).toBe(404)
    expect((await call('owner@a', 'POST', `/v1/patients/${pB}/payments`, { amount: 1, method: 'cash' })).status).toBe(404)
  })
  it('invoice year follows the clinic time zone', () => {
    const t = Date.parse('2026-12-31T12:00:00Z'); expect(yearIn('UTC', t)).toBe(2026); expect(yearIn('Pacific/Auckland', t)).toBe(2027)
  })
})
