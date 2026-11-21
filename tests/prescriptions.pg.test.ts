// Real PostgreSQL: doctor-created templates, drafts, issue with gap-free RX numbers, immutability, correction chain, void, print, races.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { harness } from './pg/harness'

let h: Awaited<ReturnType<typeof harness>>, pid: string, dentistId: string
const item = (name = 'Amoxicillin') => ({ name, strength: '500 mg', dosage: '1 cap', frequency: '3/day', duration: '7 days' })
const draft = async (items: object[] = [item()], extra: object = {}) => (await h.json(await h.call('dentA', 'POST', `/v1/patients/${pid}/prescriptions`, { dentistId, items, ...extra }))).id as string
const issue = (id: string, v = 1, who = 'dentA') => h.call(who, 'POST', `/v1/prescriptions/${id}/issue`, { expectedVersion: v, acknowledged: [] })
const get = async (id: string) => h.json(await h.call('dentA', 'GET', `/v1/prescriptions/${id}`))

beforeAll(async () => {
  h = await harness()
  pid = (await h.json(await h.call('recA', 'POST', '/v1/patients', { fullName: 'Rx Patient', birthDate: '1990-05-01' }))).id
  const d = await h.json(await h.call('ownerA', 'POST', '/v1/dentists', { name: 'Dr Rx', registration: 'REG-1' })); dentistId = d.id
})
afterAll(async () => { await h.drop() })

describe('templates', () => {
  it('personal and clinic templates: visibility, optimistic edit, archive', async () => {
    const mine = (await h.json(await h.call('dentA', 'POST', '/v1/rx-templates', { name: 'Extraction', items: [item('Ibuprofen')] }))).id
    expect((await h.call('dentA', 'POST', '/v1/rx-templates', { name: 'Shared', scope: 'clinic', items: [] })).status).toBe(201) // dentist has approve
    expect((await h.call('recA', 'POST', '/v1/rx-templates', { name: 'x' })).status).toBe(403)
    const l = await h.json(await h.call('dentA', 'GET', '/v1/rx-templates')); expect(l.items.map((t: any) => t.name)).toEqual(['Extraction', 'Shared'])
    expect((await h.json(await h.call('ownerA', 'GET', '/v1/rx-templates'))).items.map((t: any) => t.name)).toEqual(['Shared']) // personal stays personal
    expect((await h.call('dentA', 'PUT', `/v1/rx-templates/${mine}`, { name: 'Extraction 2', items: [], expectedVersion: 1 })).status).toBe(204)
    expect((await h.call('dentA', 'PUT', `/v1/rx-templates/${mine}`, { name: 'again', items: [], expectedVersion: 1 })).status).toBe(409)
    expect((await h.call('ownerA', 'PUT', `/v1/rx-templates/${mine}`, { name: 'hijack', items: [], expectedVersion: 2 })).status).toBe(404)
    expect((await h.call('dentA', 'DELETE', `/v1/rx-templates/${mine}`)).status).toBe(204)
    expect((await h.call('ownerB', 'GET', '/v1/rx-templates')).status).toBe(200)
  })
  it('using a template copies items into the draft', async () => {
    const t = (await h.json(await h.call('dentA', 'POST', '/v1/rx-templates', { name: 'Copy me', items: [item('Paracetamol')] }))).id
    const id = (await h.json(await h.call('dentA', 'POST', `/v1/patients/${pid}/prescriptions`, { dentistId, templateId: t }))).id
    await h.call('dentA', 'PUT', `/v1/rx-templates/${t}`, { name: 'Copy me', items: [], expectedVersion: 1 })
    expect((await get(id)).items[0].name).toBe('Paracetamol')
  })
})

describe('prescriptions', () => {
  it('draft is editable with expectedVersion; discarding leaves nothing behind', async () => {
    const id = await draft(); expect((await get(id)).status).toBe('draft')
    expect((await h.call('dentA', 'PUT', `/v1/prescriptions/${id}`, { expectedVersion: 1, items: [item('Other')] })).status).toBe(204)
    expect((await h.call('dentA', 'PUT', `/v1/prescriptions/${id}`, { expectedVersion: 1, items: [] })).status).toBe(409)
    expect((await h.call('dentA', 'DELETE', `/v1/prescriptions/${id}`)).status).toBe(204)
    expect((await h.db.rows('SELECT 1 FROM prescription_event WHERE prescription_id=$1', [id])).length).toBe(0)
  })
  it('issue: needs approve, a dentist and a medication; freezes content; numbers RX-year-seq', async () => {
    expect((await h.call('dentA', 'POST', `/v1/patients/${pid}/prescriptions`, { items: [item()] })).status).toBe(201)
    const noDentist = (await h.db.rows<{ id: string }>("SELECT id FROM prescription WHERE dentist_id IS NULL LIMIT 1"))[0].id
    expect((await issue(noDentist)).status).toBe(400)
    expect((await issue(await draft([]))).status).toBe(400)
    const id = await draft(); expect((await issue(id, 1, 'recA')).status).toBe(403)
    const r = await issue(id); expect(r.status).toBe(200); const { number } = await h.json(r); expect(number).toMatch(/^RX-2026-\d{4}$/)
    const x = await get(id); expect(x.status).toBe('issued'); expect(x.snapshot.patient.name).toBe('Rx Patient'); expect(x.snapshot.dentist.registration).toBe('REG-1')
    expect((await h.call('dentA', 'PUT', `/v1/prescriptions/${id}`, { expectedVersion: x.version, items: [] })).status).toBe(409)
    expect((await h.call('dentA', 'DELETE', `/v1/prescriptions/${id}`)).status).toBe(409)
    await expect(h.db.run("UPDATE prescription SET notes='tampered' WHERE id=$1", [id])).rejects.toThrow()
    await expect(h.db.run("UPDATE prescription SET items='[]' WHERE id=$1", [id])).rejects.toThrow()
    await expect(h.db.run('DELETE FROM prescription WHERE id=$1', [id])).rejects.toThrow()
    expect((await issue(id, x.version)).status).toBe(409)
  })
  it('20 parallel issues give unique gap-free numbers; a double issue of one draft succeeds once', async () => {
    const ids = await Promise.all(Array.from({ length: 20 }, () => draft()))
    const rs = await Promise.all(ids.map((i) => issue(i))); expect(rs.every((r) => r.status === 200)).toBe(true)
    const seqs = (await h.db.rows<{ seq: number }>("SELECT seq FROM prescription WHERE clinic_id=$1 AND status='issued' ORDER BY seq", [h.A.clinicId])).map((r) => r.seq)
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1))
    const one = await draft(); const two = await Promise.all([issue(one), issue(one)]); expect(two.map((r) => r.status).sort()).toEqual([200, 409])
  })
  it('correction: new linked draft; original is superseded only when the correction is issued; one open correction at a time', async () => {
    const o = await draft(); await issue(o)
    const c1 = await h.call('dentA', 'POST', `/v1/prescriptions/${o}/correct`, { reason: 'wrong dose' }); expect(c1.status).toBe(201)
    expect((await h.call('dentA', 'POST', `/v1/prescriptions/${o}/correct`, { reason: 'again' })).status).toBe(409)
    expect((await get(o)).status).toBe('issued')
    const cid = (await h.json(c1)).id; expect((await issue(cid)).status).toBe(200)
    const orig = await get(o); expect(orig.status).toBe('superseded'); expect(orig.supersededById).toBe(cid)
    expect((await h.call('ownerA', 'POST', `/v1/prescriptions/${o}/void`, { reason: 'x' })).status).toBe(409)
    const hist = (await h.json(await h.call('dentA', 'GET', `/v1/prescriptions/${o}/history`))).items.map((e: any) => e.kind); expect(hist).toEqual(['created', 'issued', 'superseded'])
  })
  it('void needs a reason and keeps the record', async () => {
    const id = await draft(); expect((await h.call('dentA', 'POST', `/v1/prescriptions/${id}/void`, { reason: 'x' })).status).toBe(409) // drafts are discarded, not voided
    await issue(id)
    expect((await h.call('dentA', 'POST', `/v1/prescriptions/${id}/void`, {})).status).toBe(400)
    expect((await h.call('dentA', 'POST', `/v1/prescriptions/${id}/void`, { reason: 'patient allergy' })).status).toBe(204)
    expect((await get(id)).status).toBe('voided'); expect((await h.db.rows('SELECT 1 FROM prescription WHERE id=$1', [id])).length).toBe(1)
    await expect(h.db.run("UPDATE prescription SET status='issued' WHERE id=$1", [id])).rejects.toThrow()
  })
  it('lists paged; isolation across clinics; print escapes HTML and supports French', async () => {
    const a = await h.json(await h.call('dentA', 'GET', `/v1/patients/${pid}/prescriptions?limit=5`)); expect(a.items.length).toBe(5); expect(a.nextCursor).toBeTruthy()
    expect((await h.call('dentA', 'GET', `/v1/patients/${pid}/prescriptions?limit=500`)).status).toBe(400)
    expect((await h.call('ownerB', 'GET', `/v1/patients/${pid}/prescriptions`)).status).toBe(404)
    const id = await draft([{ name: '<script>alert(1)</script>' }]); await issue(id)
    expect((await h.call('ownerB', 'GET', `/v1/prescriptions/${id}`)).status).toBe(404)
    const pr = await h.call('dentA', 'GET', `/v1/prescriptions/${id}/print?lang=fr`); const html = await pr.text()
    expect(html).not.toContain('<script>alert'); expect(html).toContain('&lt;script&gt;'); expect(html).toContain('Ordonnance'); expect(pr.headers.get('content-security-policy')).toContain("default-src 'none'")
  })
})
