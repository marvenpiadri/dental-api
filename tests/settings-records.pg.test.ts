// Real PostgreSQL: clinic settings/profile (revisions, validation, permissions), closures, price list, letters, insurance, waiting list, messages.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { harness } from './pg/harness'

let h: Awaited<ReturnType<typeof harness>>, pid: string
beforeAll(async () => { h = await harness(); pid = (await h.json(await h.call('recA', 'POST', '/v1/patients', { fullName: 'Rec Patient' }))).id })
afterAll(async () => { await h.drop() })

describe('clinic settings and profile', () => {
  it('everyone reads; owner saves with expectedVersion; stale save is 409; unknown fields rejected', async () => {
    expect((await h.json(await h.call('recA', 'GET', '/v1/clinic'))).version).toBe(0)
    const put = (v: number, s: object, who = 'ownerA', extra: object = {}) => h.call(who, 'PUT', '/v1/clinic', { expectedVersion: v, settings: s, ...extra })
    expect((await put(0, { legalName: 'A SARL', taxId: 'ICE123', paymentDays: 30, countryCode: 'MA', payers: [{ id: 'cnss', type: 'public', name: 'CNSS' }] }, 'ownerA', { currency: 'EUR', timezone: 'Europe/Paris' })).status).toBe(200)
    const c = await h.json(await h.call('recA', 'GET', '/v1/clinic')); expect(c.version).toBe(1); expect(c.currency).toBe('EUR'); expect(c.settings.payers[0].name).toBe('CNSS')
    expect((await put(0, {})).status).toBe(409)
    expect((await put(1, { hacker: 1 })).status).toBe(400)
    expect((await put(1, { paymentDays: 999 })).status).toBe(400)
    expect((await put(1, {}, 'ownerA', { timezone: 'Mars/Base' })).status).toBe(400)
    expect((await put(1, { logo: 'javascript:alert(1)' })).status).toBe(400)
    expect((await put(1, {}, 'recA')).status).toBe(403)
    expect((await h.json(await h.call('ownerB', 'GET', '/v1/clinic'))).currency).toBe('MAD') // other clinic untouched
  })
  it('profile is owner-only with its own revision', async () => {
    expect((await h.call('dentA', 'PUT', '/v1/clinic/profile', { expectedVersion: 0, profile: { state: 'draft' } })).status).toBe(403)
    expect((await h.call('ownerA', 'PUT', '/v1/clinic/profile', { expectedVersion: 0, profile: { state: 'published', displayName: 'Cabinet A', slug: 'cabinet-a', lat: 33.5, lng: -7.6, services: ['x'] } })).status).toBe(200)
    expect((await h.call('ownerA', 'PUT', '/v1/clinic/profile', { expectedVersion: 0, profile: { state: 'draft' } })).status).toBe(409)
    expect((await h.call('ownerA', 'PUT', '/v1/clinic/profile', { expectedVersion: 1, profile: { state: 'draft', slug: 'Bad Slug' } })).status).toBe(400)
    expect((await h.call('ownerA', 'PUT', '/v1/clinic/profile', { expectedVersion: 1, profile: { state: 'draft', lat: 999 } })).status).toBe(400)
    const g = await h.json(await h.call('recA', 'GET', '/v1/clinic/profile')); expect(g.profile.displayName).toBe('Cabinet A'); expect(g.version).toBe(1)
    expect((await h.json(await h.call('ownerA', 'GET', '/v1/clinic'))).version).toBe(1) // settings revision unaffected
  })
})

describe('closures and price list', () => {
  it('closures are read by date range and bounded', async () => {
    expect((await h.call('ownerA', 'POST', '/v1/clinic/closures', { from: '2026-12-24', to: '2026-12-26', reason: 'Holidays' })).status).toBe(201)
    expect((await h.call('ownerA', 'POST', '/v1/clinic/closures', { from: '2026-12-26', to: '2026-12-24' })).status).toBe(400)
    expect((await h.call('recA', 'POST', '/v1/clinic/closures', { from: '2026-12-01' })).status).toBe(403)
    const l = await h.json(await h.call('recA', 'GET', '/v1/clinic/closures?from=2026-12-01&to=2026-12-31')); expect(l.items.length).toBe(1)
    expect((await h.json(await h.call('recA', 'GET', '/v1/clinic/closures?from=2027-01-01&to=2027-01-31'))).items.length).toBe(0)
    expect((await h.call('recA', 'GET', '/v1/clinic/closures')).status).toBe(400)
    expect((await h.call('recA', 'GET', '/v1/clinic/closures?from=2020-01-01&to=2026-12-31')).status).toBe(400)
    expect((await h.call('ownerB', 'DELETE', `/v1/clinic/closures/${l.items[0].id}`)).status).toBe(404)
    expect((await h.call('ownerA', 'DELETE', `/v1/clinic/closures/${l.items[0].id}`)).status).toBe(204)
  })
  it('price list: exact prices, upsert, archive, permissions', async () => {
    expect((await h.call('ownerA', 'PUT', '/v1/catalog/filling', { price: 300 })).status).toBe(204)
    expect((await h.call('ownerA', 'PUT', '/v1/catalog/custom-1', { name: 'Whitening', price: '1200.50' })).status).toBe(204)
    expect((await h.call('ownerA', 'PUT', '/v1/catalog/filling', { price: 350 })).status).toBe(204)
    for (const bad of [{ price: -1 }, { price: '1.005' }, { price: 'x' }]) expect((await h.call('ownerA', 'PUT', '/v1/catalog/x', bad)).status).toBe(400)
    expect((await h.call('ownerA', 'PUT', '/v1/catalog/bad code', { price: 1 })).status).toBe(400)
    expect((await h.call('recA', 'PUT', '/v1/catalog/x', { price: 1 })).status).toBe(403)
    const l = await h.json(await h.call('recA', 'GET', '/v1/catalog')); expect(l.items).toEqual([{ id: 'custom-1', name: 'Whitening', price: 1200.5 }, { id: 'filling', price: 350 }])
    expect((await h.call('ownerA', 'DELETE', '/v1/catalog/custom-1')).status).toBe(204)
    expect((await h.json(await h.call('ownerB', 'GET', '/v1/catalog'))).items).toEqual([])
  })
})

describe('letters, insurance, waiting list, messages', () => {
  it('letters: written once; certificate and referral rules; paged; permissions; immutable in the database', async () => {
    const post = (b: object, who = 'dentA') => h.call(who, 'POST', `/v1/patients/${pid}/letters`, b)
    expect((await post({ kind: 'certificate', restDays: 3, text: 'Rest advised' })).status).toBe(201)
    expect((await post({ kind: 'referral', to: 'Dr Orthodontist', text: 'Please see' })).status).toBe(201)
    for (const bad of [{ kind: 'x', text: 'a' }, { kind: 'referral', restDays: 2, text: 'a' }, { kind: 'certificate', to: 'x', text: 'a' }, { kind: 'certificate', text: '  ' }]) expect((await post(bad)).status).toBe(400)
    expect((await post({ kind: 'certificate', text: 'a' }, 'recA')).status).toBe(403)
    const l = await h.json(await h.call('dentA', 'GET', `/v1/patients/${pid}/letters?limit=1`)); expect(l.items.length).toBe(1); expect(l.nextCursor).toBeTruthy()
    expect((await h.call('ownerB', 'GET', `/v1/patients/${pid}/letters`)).status).toBe(404)
    await expect(h.db.run("UPDATE letter SET text='x'")).rejects.toThrow(); await expect(h.db.run('DELETE FROM letter')).rejects.toThrow()
  })
  it('insurance: add, list, remove, isolated', async () => {
    const id = (await h.json(await h.call('recA', 'POST', `/v1/patients/${pid}/insurances`, { providerId: 'cnss', providerName: 'CNSS', number: '123456' }))).id
    expect((await h.call('recA', 'POST', `/v1/patients/${pid}/insurances`, { providerId: 'cnss', providerName: 'CNSS', number: '' })).status).toBe(400)
    expect((await h.json(await h.call('acctA', 'GET', `/v1/patients/${pid}/insurances`))).items.length).toBe(1)
    expect((await h.call('ownerB', 'DELETE', `/v1/insurances/${id}`)).status).toBe(404)
    expect((await h.call('recA', 'DELETE', `/v1/insurances/${id}`)).status).toBe(204)
    expect((await h.json(await h.call('acctA', 'GET', `/v1/patients/${pid}/insurances`))).items.length).toBe(0)
  })
  it('waiting list: set once, ordered, paged, cleared', async () => {
    const p2 = (await h.json(await h.call('recA', 'POST', '/v1/patients', { fullName: 'Second' }))).id
    expect((await h.call('recA', 'PUT', `/v1/patients/${pid}/waiting`)).status).toBe(204); expect((await h.call('recA', 'PUT', `/v1/patients/${p2}/waiting`)).status).toBe(204)
    const l = await h.json(await h.call('recA', 'GET', '/v1/waiting?limit=1')); expect(l.items.length).toBe(1); expect(l.nextCursor).toBeTruthy()
    const l2 = await h.json(await h.call('recA', 'GET', `/v1/waiting?limit=5&cursor=${encodeURIComponent(l.nextCursor)}`)); expect(l2.items.length).toBe(1); expect(l2.items[0].patientId).not.toBe(l.items[0].patientId)
    expect((await h.call('recA', 'DELETE', `/v1/patients/${pid}/waiting`)).status).toBe(204)
    expect((await h.json(await h.call('recA', 'GET', '/v1/waiting'))).items.length).toBe(1)
    expect((await h.call('ownerB', 'PUT', `/v1/patients/${pid}/waiting`)).status).toBe(404)
    expect((await h.call('dentA', 'PUT', `/v1/patients/${pid}/waiting`)).status).toBe(204)
  })
  it('messages: blocked after decline, status only moves forward', async () => {
    const m = (await h.json(await h.call('recA', 'POST', `/v1/patients/${pid}/messages`, { kind: 'recall', text: 'Hello' }))).id
    expect((await h.call('recA', 'PATCH', `/v1/messages/${m}`, { status: 'delivered' })).status).toBe(204)
    expect((await h.call('recA', 'PATCH', `/v1/messages/${m}`, { status: 'sent' })).status).toBe(409)
    expect((await h.call('recA', 'PATCH', `/v1/messages/${m}`, { status: 'failed' })).status).toBe(204)
    expect((await h.call('recA', 'PATCH', `/v1/messages/${m}`, { status: 'read' })).status).toBe(409)
    expect((await h.json(await h.call('recA', 'GET', `/v1/patients/${pid}/messages`))).items[0].status).toBe('failed')
    await h.call('recA', 'PATCH', `/v1/patients/${pid}`, { whatsappConsent: 'declined' })
    expect((await h.call('recA', 'POST', `/v1/patients/${pid}/messages`, { kind: 'recall', text: 'Hello again' })).status).toBe(409)
    expect((await h.call('recA', 'POST', `/v1/patients/${pid}/messages`, { kind: 'bogus', text: 'x' })).status).toBe(400)
  })
})
