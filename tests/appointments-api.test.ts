// SQLite stand-in (not TiDB). Covers HTTP validation, authorization, tenant isolation and pagination.
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { hashPassword } from '../src/auth/password'
import { sqliteDb } from './helpers/sqlite-db'
import { toDb } from '../src/lib/time'

const env = { TIDB_DATABASE_URL: 'x', PASSWORD_PEPPER: 'pepper', APP_ORIGIN: 'https://app.test', API_ORIGIN: 'https://api.test' }
const db = sqliteDb(), NOW = Date.parse('2026-11-16T07:00:00Z')
const app = createApp({ db: () => db, now: () => NOW })
const H = { origin: 'https://app.test', 'x-dontalist-csrf': '1', 'content-type': 'application/json' }
const cookies: Record<string, string> = {}
const call = (who: string, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { ...H, cookie: cookies[who] }, body: body === undefined ? undefined : JSON.stringify(body) }, env)
const iso = (h: number, m = 0) => new Date(Date.parse('2026-11-16T00:00:00Z') + (h * 60 + m) * 60_000).toISOString()
const appt = (o = {}) => ({ patientId: 'pA', dentistId: 'dA', chairId: 'cA', startAt: iso(9), endAt: iso(9, 30), ...o })

beforeAll(async () => {
  const hash = await hashPassword('correct horse battery', 'pepper', { iterations: 1000, rounds: 1 }), t = toDb(NOW)
  for (const c of ['A', 'B']) {
    db.raw.prepare('INSERT INTO clinic (id,name,timezone,created_at) VALUES (?,?,?,?)').run(c, c, 'UTC', t)
    for (const [tbl, pre] of [['patient', 'p'], ['dentist_profile', 'd'], ['chair', 'c']] as const)
      db.raw.prepare(`INSERT INTO ${tbl} (id,clinic_id,${tbl === 'patient' ? 'full_name,created_at' : 'name'}) VALUES (?,?,?${tbl === 'patient' ? ',?' : ''})`).run(...[pre + c, c, 'x', ...(tbl === 'patient' ? [t] : [])] as never[])
  }
  for (const [id, clinic, role] of [['recA', 'A', 'reception'], ['acctA', 'A', 'accountant'], ['recB', 'B', 'reception']])
    db.raw.prepare('INSERT INTO staff (id,clinic_id,email_norm,name,role,password_hash,created_at) VALUES (?,?,?,?,?,?,?)').run(id, clinic, `${id.toLowerCase()}@x.test`, id, role, hash, t)
  for (const id of ['recA', 'acctA', 'recB']) {
    const r = await app.request('/v1/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ email: `${id.toLowerCase()}@x.test`, password: 'correct horse battery' }) }, env)
    cookies[id] = r.headers.get('set-cookie')!.split(';')[0]
  }
})

describe('appointments API', () => {
  it('requires a session and the right permission', async () => {
    expect((await app.request('/v1/appointments?from=a&to=b', {}, env)).status).toBe(401)
    expect((await call('acctA', 'POST', '/v1/appointments', appt())).status).toBe(403) // accountant has no appointments.create
  })
  it('books, then reports a conflict as 409 slot_taken', async () => {
    expect((await call('recA', 'POST', '/v1/appointments', appt())).status).toBe(201)
    const r = await call('recA', 'POST', '/v1/appointments', appt({ startAt: iso(9, 15), endAt: iso(9, 45) }))
    expect(r.status).toBe(409); expect(((await r.json()) as any).error.code).toBe('slot_taken')
  })
  it('validates input: off-grid, non-UTC, missing fields', async () => {
    expect((await call('recA', 'POST', '/v1/appointments', appt({ startAt: iso(11, 3), endAt: iso(11, 33) }))).status).toBe(422)
    expect((await call('recA', 'POST', '/v1/appointments', appt({ startAt: '2026-11-16T11:00:00+01:00' }))).status).toBe(400)
    expect((await call('recA', 'POST', '/v1/appointments', { patientId: 'pA' })).status).toBe(400)
  })
  it("never lets one clinic reference or touch another clinic's rows", async () => {
    expect((await call('recA', 'POST', '/v1/appointments', appt({ patientId: 'pB' }))).status).toBe(404)
    const id = ((await (await call('recB', 'POST', '/v1/appointments', appt({ patientId: 'pB', dentistId: 'dB', chairId: 'cB' }))).json()) as any).id
    expect((await call('recA', 'POST', `/v1/appointments/${id}/status`, { status: 'cancelled' })).status).toBe(422) // not found in clinic A
    const list = (await (await call('recA', 'GET', `/v1/appointments?from=${iso(0)}&to=${iso(23)}`)).json()) as any
    expect(list.items.every((x: any) => x.patientId === 'pA')).toBe(true)
  })
  it('lists a date range with keyset pagination and caps/rejects bad parameters', async () => {
    for (let i = 0; i < 4; i++) await call('recA', 'POST', '/v1/appointments', appt({ patientId: 'pA', startAt: iso(12 + i), endAt: iso(12 + i, 30) }))
    const q = `from=${iso(0)}&to=${iso(23)}`
    const p1 = (await (await call('recA', 'GET', `/v1/appointments?${q}&limit=2`)).json()) as any
    expect(p1.items).toHaveLength(2); expect(p1.nextCursor).toBeTruthy()
    const p2 = (await (await call('recA', 'GET', `/v1/appointments?${q}&limit=2&cursor=${p1.nextCursor}`)).json()) as any
    expect(p2.items[0].startAt > p1.items[1].startAt).toBe(true)
    for (const bad of [`limit=101`, `limit=0`, `cursor=%%%`, 'from=x&to=y']) expect((await call('recA', 'GET', `/v1/appointments?${bad.startsWith('from') ? bad : q + '&' + bad}`)).status).toBe(400)
    expect((await call('recA', 'GET', `/v1/appointments?from=${iso(0)}&to=2027-06-01T00:00:00Z`)).status).toBe(400) // > 62 days
  })
  it('reschedules with a version and rejects a stale one; status changes work', async () => {
    const id = ((await (await call('recA', 'POST', '/v1/appointments', appt({ startAt: iso(16), endAt: iso(16, 30) }))).json()) as any).id
    expect((await call('recA', 'POST', `/v1/appointments/${id}/reschedule`, { version: 1, startAt: iso(17), endAt: iso(17, 30) })).status).toBe(204)
    const stale = await call('recA', 'POST', `/v1/appointments/${id}/reschedule`, { version: 1, startAt: iso(18), endAt: iso(18, 30) })
    expect(stale.status).toBe(409); expect(((await stale.json()) as any).error.code).toBe('stale')
    expect((await call('recA', 'POST', `/v1/appointments/${id}/status`, { status: 'confirmed' })).status).toBe(204)
    expect((await call('recA', 'POST', `/v1/appointments/${id}/status`, { status: 'completed' })).status).toBe(422)
  })
})
