// Real PostgreSQL: operator console (create clinics, profiles, subscriptions) and the public clinic directory.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { harness, NOW } from './pg/harness'

const TOKEN = 'operator-token-operator-token-0123456789'
const env = { PASSWORD_PEPPER: 'pepper', APP_ORIGIN: 'https://app.test', API_ORIGIN: 'https://api.test', ADMIN_TOKEN: TOKEN }
const H = { origin: 'https://app.test', 'x-dontalist-csrf': '1', 'content-type': 'application/json' }
let h: Awaited<ReturnType<typeof harness>>
beforeAll(async () => { h = await harness() })
afterAll(async () => { await h.drop() })

const admin = (method: string, path: string, body?: unknown, token: string | null = TOKEN, e: object = env) =>
  h.app.request('/v1/admin' + path, { method, headers: { ...H, ...(token ? { 'x-dontalist-admin': token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }, e)
const pub = (q = '') => h.app.request('/v1/public/clinics' + q, {}, env)
const clinicBody = (o: Record<string, unknown> = {}, profile: Record<string, unknown> = {}, sub = { startsOn: '2026-11-01', endsOn: '2027-10-31' }) => ({
  clinicName: 'Cabinet Atlas SARL', owner: { name: 'Dr Atlas', email: 'atlas@example.test' }, address: '12 Rue Atlas, Rabat', phone: '+212600000000', subscription: sub,
  profile: { state: 'published', displayName: 'Cabinet Atlas', city: 'Rabat', country: 'Maroc', countryCode: 'MA', slug: 'atlas', intro: 'Soins dentaires', ...profile }, ...o,
})

describe('operator console access', () => {
  it('does not exist without a configured token, and refuses a wrong or missing one', async () => {
    expect((await admin('GET', '/clinics', undefined, TOKEN, { ...env, ADMIN_TOKEN: undefined })).status).toBe(404)
    expect((await admin('GET', '/clinics', undefined, TOKEN, { ...env, ADMIN_TOKEN: 'short' })).status).toBe(404)
    expect((await admin('GET', '/clinics', undefined, null)).status).toBe(401)
    expect((await admin('GET', '/clinics', undefined, TOKEN + 'x')).status).toBe(401)
    expect((await h.call('ownerA', 'GET', '/v1/admin/clinics')).status).toBe(404) // a clinic owner's session is not operator access (and the token is not set in the default test env)
    const r = await h.app.request('/v1/admin/clinics', { headers: { cookie: 'x=1' } }, env); expect(r.status).toBe(401)
  })
})

describe('creating a clinic with profile and subscription', () => {
  let id = '', pw = ''
  it('validates input', async () => {
    expect((await admin('POST', '/clinics', { ...clinicBody(), hacker: 1 })).status).toBe(400)
    expect((await admin('POST', '/clinics', clinicBody({ owner: { name: 'X', email: 'not-an-email' } }))).status).toBe(400)
    expect((await admin('POST', '/clinics', clinicBody({}, {}, { startsOn: '2027-01-01', endsOn: '2026-01-01' }))).status).toBe(400)
    expect((await admin('POST', '/clinics', clinicBody({}, { slug: 'Bad Slug' }))).status).toBe(400)
    expect((await admin('POST', '/clinics', clinicBody({}, { city: undefined }))).status).toBe(400) // published needs a city
    expect((await admin('POST', '/clinics', clinicBody({ subscription: undefined }))).status).toBe(400)
    expect((await h.json(await h.call('ownerA', 'GET', '/v1/clinic'))).name).toBe('A') // nothing was created by the failures
  })
  it('creates clinic, owner, profile and subscription together; the owner can sign in', async () => {
    const r = await admin('POST', '/clinics', clinicBody()); expect(r.status).toBe(201)
    const j = await h.json(r); id = j.clinicId; pw = j.temporaryPassword; expect(pw.length).toBeGreaterThanOrEqual(15); expect(j.ownerEmail).toBe('atlas@example.test')
    const login = await h.app.request('/v1/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ email: 'atlas@example.test', password: pw }) }, env)
    expect(login.status).toBe(200)
    const d = await h.json(await admin('GET', '/clinics/' + id)); expect(d.version).toBe(1); expect(d.profile.slug).toBe('atlas'); expect(d.subscriptions).toEqual([{ id: expect.any(String), startsOn: '2026-11-01', endsOn: '2027-10-31', note: null }])
  })
  it('refuses a duplicate owner email and a duplicate public address', async () => {
    expect((await admin('POST', '/clinics', clinicBody({ clinicName: 'Other' }, { slug: 'other' }))).status).toBe(409) // same email
    const r = await admin('POST', '/clinics', clinicBody({ owner: { name: 'Z', email: 'z@example.test' } })); expect(r.status).toBe(409); expect((await h.json(r)).error.code).toBe('slug_taken')
    expect((await admin('POST', '/clinics', clinicBody({ owner: { name: 'Z', email: 'z@example.test' } }, { slug: 'atlas', city: 'Casablanca' }))).status).toBe(201) // same slug, other city: fine
  })
  it('the clinic edits its own public profile; the listing follows; the clinic cannot touch its subscription', async () => {
    const login = await h.app.request('/v1/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ email: 'atlas@example.test', password: pw }) }, env)
    const cookie = login.headers.get('set-cookie')!.split(';')[0], own = (m: string, p: string, b?: unknown) => h.app.request(p, { method: m, headers: { ...H, cookie }, body: b === undefined ? undefined : JSON.stringify(b) }, env)
    const g = await h.json(await own('GET', '/v1/clinic/profile')); expect(g.version).toBe(1)
    expect((await own('PUT', '/v1/clinic/profile', { expectedVersion: 1, profile: { ...g.profile, intro: 'Nouvelle présentation' } })).status).toBe(200)
    const list = await h.json(await pub('?q=atlas')); expect(list.items.find((i: any) => i.name === 'Cabinet Atlas').intro).toBe('Nouvelle présentation')
    expect((await own('POST', `/v1/admin/clinics/${id}/subscriptions`, { startsOn: '2030-01-01', endsOn: '2030-12-31' })).status).toBe(401) // a clinic session is not the operator token
    const clash = await own('PUT', '/v1/clinic/profile', { expectedVersion: 2, profile: { ...g.profile, city: 'Casablanca' } }); expect(clash.status).toBe(409) // would take the Casablanca "atlas" address
    expect((await h.json(clash)).error.code).toBe('slug_taken')
  })
  it('admin edits the profile with a version check (two writers: one wins)', async () => {
    const d = await h.json(await admin('GET', '/clinics/' + id))
    const put = () => admin('PUT', '/clinics/' + id, { expectedVersion: d.version, profile: { ...d.profile, intro: 'Admin edit' }, address: '14 Rue Atlas, Rabat' })
    const [a, b] = await Promise.all([put(), put()]); expect([a.status, b.status].sort()).toEqual([200, 409])
    expect((await h.json(await admin('GET', '/clinics/' + id))).address).toBe('14 Rue Atlas, Rabat')
  })
})

describe('subscription periods', () => {
  it('records periods, refuses overlaps, and the listing only shows clinics covered today', async () => {
    const r = await admin('POST', '/clinics', clinicBody({ clinicName: 'Sub Clinic', owner: { name: 'S', email: 's@example.test' } }, { slug: 'sub-clinic', displayName: 'Sub Clinic' }, { startsOn: '2026-01-01', endsOn: '2026-06-30' }))
    const id = (await h.json(r)).clinicId
    expect((await h.json(await pub('?q=sub clinic'))).total).toBe(0) // NOW is 2026-11-16: expired
    expect((await admin('POST', `/clinics/${id}/subscriptions`, { startsOn: '2026-06-30', endsOn: '2027-01-01' })).status).toBe(409) // overlaps on 30 June
    expect((await admin('POST', `/clinics/${id}/subscriptions`, { startsOn: '2026-07-01', endsOn: '2025-01-01' })).status).toBe(400)
    const add = await admin('POST', `/clinics/${id}/subscriptions`, { startsOn: '2026-07-01', endsOn: '2027-06-30', note: 'paid by transfer' }); expect(add.status).toBe(201)
    expect((await h.json(await pub('?q=sub clinic'))).total).toBe(1)
    expect((await h.json(await admin('GET', '/clinics?q=sub clinic'))).items[0].subscription).toBe('active')
    expect((await admin('DELETE', `/clinics/${id}/subscriptions/${(await h.json(add)).id}`)).status).toBe(204)
    expect((await h.json(await pub('?q=sub clinic'))).total).toBe(0)
    expect((await admin('DELETE', `/clinics/${h.B.clinicId}/subscriptions/${crypto.randomUUID()}`)).status).toBe(404)
  })
  it('an upcoming period is not active yet', async () => {
    const r = await admin('POST', '/clinics', clinicBody({ clinicName: 'Future', owner: { name: 'F', email: 'f@example.test' } }, { slug: 'future', displayName: 'Future' }, { startsOn: '2027-01-01', endsOn: '2027-12-31' }))
    expect(r.status).toBe(201); expect((await h.json(await pub('?q=future'))).total).toBe(0)
    expect((await h.json(await admin('GET', '/clinics?q=future'))).items[0].subscription).toBe('upcoming')
  })
})

describe('public directory', () => {
  beforeAll(async () => {
    // 30 listed clinics by SQL (fast), alternating cities; plus a draft that must never appear.
    for (let i = 0; i < 30; i++) {
      const id = crypto.randomUUID(), city = i % 2 ? 'Fès' : 'Tanger', n = String(i).padStart(2, '0')
      await h.db.run('INSERT INTO clinic (id, name, created_at) VALUES ($1, $2, now())', [id, `Bulk ${n}`])
      await h.db.run('INSERT INTO clinic_settings (clinic_id, profile, settings, updated_at) VALUES ($1, $2::jsonb, $3::jsonb, now())', [id, JSON.stringify({ state: i === 7 ? 'draft' : 'published', displayName: `Bulk ${n}`, city, country: 'Maroc', countryCode: 'MA', slug: `bulk-${n}`, website: i === 3 ? 'javascript:alert(1)' : 'https://example.test/' + n }), JSON.stringify({ address: `${n} Rue Bulk`, legalName: 'SECRET LEGAL', taxId: 'ICE-SECRET' })])
      await h.db.run("INSERT INTO clinic_subscription (id, clinic_id, starts_on, ends_on, created_at) VALUES ($1, $2, '2026-01-01', '2027-01-01', now())", [crypto.randomUUID(), id])
    }
  })
  it('is public, paginated with a deterministic order, capped, and counts only listed clinics', async () => {
    const r = await pub('?q=bulk&limit=10'); expect(r.status).toBe(200)
    const p1 = await h.json(r); expect(p1.total).toBe(29); expect(p1.items.length).toBe(10); expect(p1.items[0].name).toBe('Bulk 00'); expect(r.headers.get('access-control-allow-origin')).toBe('*'); expect(r.headers.get('cache-control')).toContain('public')
    const p3 = await h.json(await pub('?q=bulk&limit=10&offset=20')); expect(p3.items.length).toBe(9); expect(p3.items.map((i: any) => i.name)).not.toContain('Bulk 07')
    expect((await h.json(await pub('?q=bulk&limit=10&offset=500'))).items).toEqual([])
    expect((await pub('?limit=51')).status).toBe(400); expect((await pub('?limit=0')).status).toBe(400); expect((await pub('?offset=-1')).status).toBe(400); expect((await pub('?offset=abc')).status).toBe(400); expect((await pub('?q=' + 'x'.repeat(81))).status).toBe(400)
  })
  it('filters by city and search, lists the cities, and returns only public fields', async () => {
    const f = await h.json(await pub('?city=fès&q=bulk&limit=50')); expect(f.total).toBe(14); expect(f.items.every((i: any) => i.city === 'Fès')).toBe(true)
    expect(f.cities).toEqual(expect.arrayContaining(['Fès', 'Rabat', 'Tanger']))
    const one = await h.json(await pub('?q=00 rue bulk')); expect(one.items[0].address).toBe('00 Rue Bulk'); expect(one.items[0].path).toBe('/clinics/maroc/tanger/bulk-00')
    const all = JSON.stringify(await h.json(await pub('?limit=50'))); for (const secret of ['SECRET', 'ICE-', 'owner@', 'atlas@', 'password']) expect(all).not.toContain(secret)
    expect((await h.json(await pub('?q=bulk 03'))).items[0].website).toBeNull() // javascript: URLs never leave the API
    expect((await h.json(await pub('?q=%25'))).total).toBe(0) // % is plain text, not a wildcard
  })
  it('does not list clinics that unpublish or clinics of another state', async () => {
    const d = await h.json(await admin('GET', '/clinics?q=atlas')); const atlas = d.items.find((i: any) => i.city === 'Rabat')
    const full = await h.json(await admin('GET', '/clinics/' + atlas.id)); expect((await admin('PUT', '/clinics/' + atlas.id, { expectedVersion: full.version, profile: { ...full.profile, state: 'unpublished' } })).status).toBe(200)
    expect((await h.json(await pub('?q=cabinet atlas&city=rabat'))).total).toBe(0)
  })
  it('the admin list is bounded and shows subscription status', async () => {
    const l = await h.json(await admin('GET', '/clinics?limit=5')); expect(l.items.length).toBe(5); expect(l.total).toBeGreaterThan(30)
    expect((await admin('GET', '/clinics?limit=101')).status).toBe(400)
  })
})
