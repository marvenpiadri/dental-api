// SQLite stand-in (not TiDB): drafts, templates, issue, immutability, void, corrections, print escaping, permissions, isolation, same-number race.
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createClinic } from '../src/admin/bootstrap'
import { sqliteDb } from './helpers/sqlite-db'
import { toDb } from '../src/lib/time'
import { cleanItems, esc } from '../src/clinical/prescriptions'

const env = { TIDB_DATABASE_URL: 'x', PASSWORD_PEPPER: 'pepper', APP_ORIGIN: 'https://app.test', API_ORIGIN: 'https://api.test' }
const db = sqliteDb(), NOW = Date.parse('2026-11-16T07:00:00Z'), PW = 'correct horse battery'
const app = createApp({ db: () => db, now: () => NOW })
const H = { origin: 'https://app.test', 'x-dontalist-csrf': '1', 'content-type': 'application/json' }
const ck: Record<string, string> = {}
const call = (who: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { ...H, cookie: ck[who] }, body: body === undefined ? undefined : JSON.stringify(body) }, env)
const json = async (r: Response) => (await r.json()) as any
const login = async (email: string) => (await app.request('/v1/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ email, password: PW }) }, env)).headers.get('set-cookie')!.split(';')[0]
const amox = { name: 'Amoxicillin', strength: '500 mg', dosage: '1 capsule', frequency: '3 times a day', duration: '7 days' }
let pA = '', pB = '', dentistId = ''
const draft = async (items: unknown[] = [amox], extra: object = {}) => (await json(await call('dent@a', 'POST', `/v1/patients/${pA}/prescriptions`, { dentistId, items, ...extra }))).id as string
const issue = (id: string, who = 'dent@a', v?: number) => call(who, 'POST', `/v1/prescriptions/${id}/issue`, { expectedVersion: v ?? 1 })

beforeAll(async () => {
  const a = await createClinic(db, 'pepper', { clinicName: 'A', ownerEmail: 'owner@a.test', ownerName: 'O', password: PW })
  await createClinic(db, 'pepper', { clinicName: 'B', ownerEmail: 'owner@b.test', ownerName: 'Ob', password: PW })
  const hash = (db.raw.prepare("SELECT password_hash h FROM staff WHERE email_norm='owner@a.test'").get() as any).h
  for (const [id, role] of [['dent', 'dentist'], ['dent2', 'dentist'], ['assist', 'assistant'], ['rec', 'reception']]) db.raw.prepare('INSERT INTO staff (id,clinic_id,email_norm,name,role,password_hash,created_at) VALUES (?,?,?,?,?,?,?)').run(id, a.clinicId, `${id}@a.test`, id, role, hash, toDb(NOW))
  dentistId = 'dp1'; db.raw.prepare("INSERT INTO dentist_profile (id, clinic_id, name, registration) VALUES ('dp1', ?, 'Dr <b>Smith</b>', 'REG-9')").run(a.clinicId)
  for (const w of ['owner@a', 'owner@b', 'dent@a', 'dent2@a', 'assist@a', 'rec@a']) ck[w] = await login(`${w}.test`)
  pA = (await json(await call('owner@a', 'POST', '/v1/patients', { fullName: 'Pat <script>A' }))).id; pB = (await json(await call('owner@b', 'POST', '/v1/patients', { fullName: 'Pat B' }))).id
})

describe('items', () => {
  it('whitelists, bounds and requires names only at issue', () => {
    expect(cleanItems([{ name: 'X', evil: 1 }], false)[0]).not.toHaveProperty('evil')
    expect(() => cleanItems([{ dosage: 'x' }], true)).toThrow(); expect(() => cleanItems([], true)).toThrow(); expect(() => cleanItems(Array(31).fill({ name: 'a' }), false)).toThrow()
    expect(() => cleanItems([{ name: 'a'.repeat(201) }], false)).toThrow()
  })
  it('escapes HTML', () => expect(esc(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;'))
})
describe('draft → issued', () => {
  it('drafts have no number, edit with a version, and discard', async () => {
    const id = await draft(); let r = await json(await call('dent@a', 'GET', `/v1/prescriptions/${id}`)); expect(r).toMatchObject({ status: 'draft', version: 1 }); expect(r.number).toBeUndefined()
    expect((await call('assist@a', 'PUT', `/v1/prescriptions/${id}`, { expectedVersion: 1, notes: 'rest' })).status).toBe(204) // assistants may prepare drafts
    expect((await call('dent@a', 'PUT', `/v1/prescriptions/${id}`, { expectedVersion: 1, notes: 'x' })).status).toBe(409)
    expect((await call('dent@a', 'DELETE', `/v1/prescriptions/${id}`)).status).toBe(204); expect((await call('dent@a', 'GET', `/v1/prescriptions/${id}`)).status).toBe(404)
  })
  it('issue needs approve permission, a dentist, and a named medication; numbers run per clinic', async () => {
    const id = await draft(); expect((await issue(id, 'assist@a')).status).toBe(403); expect((await issue(id, 'rec@a')).status).toBe(403)
    const noName = await draft([{ dosage: 'x' }]); expect((await issue(noName)).status).toBe(400)
    const noDentist = (await json(await call('dent@a', 'POST', `/v1/patients/${pA}/prescriptions`, { items: [amox] }))).id; expect((await issue(noDentist)).status).toBe(400)
    const n1 = (await json(await issue(id))).number, n2 = (await json(await issue(await draft()))).number
    expect(n1).toMatch(/^RX-2026-\d{4}$/); expect(Number(n2.slice(-4))).toBe(Number(n1.slice(-4)) + 1)
    const r = await json(await call('dent@a', 'GET', `/v1/prescriptions/${id}`)); expect(r).toMatchObject({ status: 'issued', number: n1 }); expect(r.snapshot.dentist.name).toBe('Dr <b>Smith</b>'); expect(r.snapshot.patient.name).toBe('Pat <script>A')
  })
  it('issued is immutable: no edit, discard, re-issue; snapshot ignores later profile edits', async () => {
    const id = await draft([amox], { notes: 'n' }); await issue(id)
    expect((await call('dent@a', 'PUT', `/v1/prescriptions/${id}`, { expectedVersion: 2, notes: 'changed' })).status).toBe(409)
    expect((await call('dent@a', 'DELETE', `/v1/prescriptions/${id}`)).status).toBe(409); expect((await issue(id, 'dent@a', 2)).status).toBe(409)
    db.raw.prepare("UPDATE patient SET full_name = 'Renamed' WHERE id = ?").run(pA)
    expect((await json(await call('dent@a', 'GET', `/v1/prescriptions/${id}`))).snapshot.patient.name).toBe('Pat <script>A')
    expect((await json(await call('dent@a', 'GET', `/v1/prescriptions/${id}`))).notes).toBe('n')
  })
  it('a double issue gets one winner and one number', async () => {
    const id = await draft(), [a, b] = await Promise.all([issue(id), issue(id)])
    expect([a.status, b.status].sort()).toEqual([200, 409])
  })
})
describe('void and correction', () => {
  it('void needs a reason and issued status; keeps the record; is logged', async () => {
    const id = await draft(); await issue(id)
    expect((await call('dent@a', 'POST', `/v1/prescriptions/${id}/void`, { reason: ' ' })).status).toBe(400)
    expect((await call('assist@a', 'POST', `/v1/prescriptions/${id}/void`, { reason: 'x' })).status).toBe(403)
    expect((await call('dent@a', 'POST', `/v1/prescriptions/${id}/void`, { reason: 'wrong drug' })).status).toBe(204)
    expect((await call('dent@a', 'POST', `/v1/prescriptions/${id}/void`, { reason: 'again' })).status).toBe(409)
    expect(await json(await call('dent@a', 'GET', `/v1/prescriptions/${id}`))).toMatchObject({ status: 'voided', voidReason: 'wrong drug' })
    expect((await json(await call('dent@a', 'GET', `/v1/prescriptions/${id}/history`))).items.map((e: any) => e.kind)).toEqual(['created', 'issued', 'voided'])
    expect((await call('dent@a', 'POST', `/v1/prescriptions/${id}/correct`, { reason: 'x' })).status).toBe(409) // voided ones are not corrected
  })
  it('a correction links to the original and supersedes it only once issued', async () => {
    const id = await draft(); await issue(id)
    expect((await call('dent@a', 'POST', `/v1/prescriptions/${id}/correct`, {})).status).toBe(400)
    const cid = (await json(await call('dent@a', 'POST', `/v1/prescriptions/${id}/correct`, { reason: 'dose typo' }))).id
    expect((await call('dent@a', 'POST', `/v1/prescriptions/${id}/correct`, { reason: 'again' })).status).toBe(409) // one correction at a time
    expect((await json(await call('dent@a', 'GET', `/v1/prescriptions/${id}`))).status).toBe('issued')
    await call('dent@a', 'PUT', `/v1/prescriptions/${cid}`, { expectedVersion: 1, items: [{ ...amox, dosage: '2 capsules' }] })
    expect((await issue(cid, 'dent@a', 2)).status).toBe(200)
    expect(await json(await call('dent@a', 'GET', `/v1/prescriptions/${id}`))).toMatchObject({ status: 'superseded', supersededById: cid })
    expect(await json(await call('dent@a', 'GET', `/v1/prescriptions/${cid}`))).toMatchObject({ status: 'issued', correctsId: cid === id ? '' : id, correctionReason: 'dose typo' })
  })
  it('a correction cannot be issued once its original was voided', async () => {
    const id = await draft(); await issue(id); const cid = (await json(await call('dent@a', 'POST', `/v1/prescriptions/${id}/correct`, { reason: 'r' }))).id
    await call('dent@a', 'POST', `/v1/prescriptions/${id}/void`, { reason: 'gone' }); expect((await issue(cid)).status).toBe(409)
  })
})
describe('templates', () => {
  it('personal templates are private; clinic templates need approve; use copies values', async () => {
    const mine = (await json(await call('dent@a', 'POST', '/v1/rx-templates', { name: 'Extraction', items: [amox] }))).id
    expect((await json(await call('dent2@a', 'GET', '/v1/rx-templates'))).items.some((t: any) => t.id === mine)).toBe(false)
    expect((await call('dent2@a', 'PUT', `/v1/rx-templates/${mine}`, { name: 'x', expectedVersion: 1 })).status).toBe(404)
    expect((await call('assist@a', 'POST', '/v1/rx-templates', { name: 'Shared', scope: 'clinic', items: [] })).status).toBe(403)
    const shared = (await json(await call('dent@a', 'POST', '/v1/rx-templates', { name: 'Shared', scope: 'clinic', items: [amox] }))).id
    expect((await json(await call('assist@a', 'GET', '/v1/rx-templates'))).items.map((t: any) => t.id)).toEqual([shared])
    const rx = await draft([], { templateId: shared }), before = await json(await call('dent@a', 'GET', `/v1/prescriptions/${rx}`)); expect(before.items[0]).toMatchObject({ name: 'Amoxicillin' })
    await call('dent@a', 'PUT', `/v1/rx-templates/${shared}`, { name: 'Shared', items: [{ name: 'Other' }], expectedVersion: 1 })
    expect((await json(await call('dent@a', 'GET', `/v1/prescriptions/${rx}`))).items[0].name).toBe('Amoxicillin') // later template edits never reach it
    expect((await call('dent@a', 'PUT', `/v1/rx-templates/${shared}`, { name: 'S', expectedVersion: 1 })).status).toBe(409)
    expect((await call('owner@b', 'POST', `/v1/patients/${pB}/prescriptions`, { templateId: shared })).status).toBe(400) // another clinic's template is unknown
  })
})
describe('print', () => {
  it('prints escaped A4 HTML in English or French, marks voided, blocks scripts', async () => {
    const id = await draft([{ name: '<img src=x onerror=alert(1)>', dosage: '"q"' }]); await issue(id)
    const en = await call('dent@a', 'GET', `/v1/prescriptions/${id}/print`), t = await en.text()
    expect(t).not.toContain('<img'); expect(t).not.toContain('<script'); expect(t).toContain('&lt;img'); expect(t).toContain('Prescription RX-2026-'); expect(t).toContain('Dr &lt;b&gt;Smith&lt;/b&gt;')
    expect(en.headers.get('content-security-policy')).toContain("default-src 'none'")
    const fr = await (await call('dent@a', 'GET', `/v1/prescriptions/${id}/print?lang=fr`)).text(); expect(fr).toContain('Ordonnance RX-'); expect(fr).toContain('Posologie')
    await call('dent@a', 'POST', `/v1/prescriptions/${id}/void`, { reason: 'x' }); expect(await (await call('dent@a', 'GET', `/v1/prescriptions/${id}/print?lang=fr`)).text()).toContain('ANNULÉE')
  })
})
describe('isolation, permissions and paging', () => {
  it('another clinic cannot see or act on prescriptions; receptionists cannot read clinical data', async () => {
    const id = await draft(); await issue(id)
    for (const [m, p, b] of [['GET', `/v1/prescriptions/${id}`], ['GET', `/v1/prescriptions/${id}/print`], ['GET', `/v1/prescriptions/${id}/history`], ['POST', `/v1/prescriptions/${id}/void`, { reason: 'x' }], ['POST', `/v1/prescriptions/${id}/correct`, { reason: 'x' }], ['GET', `/v1/patients/${pA}/prescriptions`]] as const) expect((await call('owner@b', m, p, b)).status, p).toBe(404)
    expect((await call('owner@b', 'POST', `/v1/patients/${pA}/prescriptions`, { items: [] })).status).toBe(404)
    expect((await call('rec@a', 'GET', `/v1/prescriptions/${id}`)).status).toBe(403)
  })
  it('lists a patient\'s prescriptions with keyset paging and a capped limit', async () => {
    const p1 = await json(await call('dent@a', 'GET', `/v1/patients/${pA}/prescriptions?limit=2`)); expect(p1.items).toHaveLength(2); expect(p1.nextCursor).toBeTruthy()
    const p2 = await json(await call('dent@a', 'GET', `/v1/patients/${pA}/prescriptions?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`)); expect(p2.items.every((x: any) => !p1.items.some((y: any) => y.id === x.id))).toBe(true)
    expect((await call('dent@a', 'GET', `/v1/patients/${pA}/prescriptions?limit=101`)).status).toBe(400)
  })
})
