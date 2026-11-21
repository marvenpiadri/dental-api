// Real PostgreSQL: visit notes (revisions, void), quotes (supersede chain), medication/allergy lists and patient records with history.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { harness } from './pg/harness'

let h: Awaited<ReturnType<typeof harness>>, pid: string
beforeAll(async () => { h = await harness(); pid = (await h.json(await h.call('recA', 'POST', '/v1/patients', { fullName: 'Visit Patient' }))).id })
afterAll(async () => { await h.drop() })

describe('visit notes', () => {
  let id: string
  it('creates, requires content, lists newest first and paged', async () => {
    const post = (b: object, who = 'dentA') => h.call(who, 'POST', `/v1/patients/${pid}/visits`, b)
    id = (await h.json(await post({ complaint: 'Pain', findings: 'Caries 36', prescription: [{ drug: 'Ibuprofen', dosage: '400mg', duration: '3d' }] }))).id
    await post({ care: 'Filling' })
    expect((await post({})).status).toBe(400); expect((await post({ complaint: 'x' }, 'recA')).status).toBe(403); expect((await post({ complaint: 'x' }, 'ownerB')).status).toBe(404)
    expect((await post({ complaint: 'x', prescription: [{ dosage: 'no drug' }] })).status).toBe(400)
    const l = await h.json(await h.call('dentA', 'GET', `/v1/patients/${pid}/visits?limit=1`)); expect(l.items[0].care).toBe('Filling'); expect(l.nextCursor).toBeTruthy()
  })
  it('a correction keeps the earlier text; stale edits are refused; races give one winner', async () => {
    const put = (v: number, b: object = {}) => h.call('dentA', 'PUT', `/v1/visits/${id}`, { expectedVersion: v, complaint: 'Pain 2', findings: 'Caries 36 deep', ...b })
    expect((await put(1)).status).toBe(200); expect((await put(1)).status).toBe(409)
    const rs = await Promise.all([1, 2, 3].map((i) => put(2, { complaint: `race ${i}` }))); expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409])
    const d = await h.json(await h.call('dentA', 'GET', `/v1/visits/${id}`)); expect(d.version).toBe(3); expect(d.revisions.length).toBe(2); expect(d.revisions[0].complaint).toBe('Pain'); expect(d.revisions[0].prescription[0].drug).toBe('Ibuprofen')
    await expect(h.db.run('DELETE FROM visit_note')).rejects.toThrow(); await expect(h.db.run('DELETE FROM visit_note_revision')).rejects.toThrow()
  })
  it('void needs a reason, keeps the note, and blocks edits', async () => {
    expect((await h.call('dentA', 'POST', `/v1/visits/${id}/void`, {})).status).toBe(400)
    expect((await h.call('dentA', 'POST', `/v1/visits/${id}/void`, { reason: 'wrong patient' })).status).toBe(204)
    expect((await h.call('dentA', 'PUT', `/v1/visits/${id}`, { expectedVersion: 3, complaint: 'x' })).status).toBe(409)
    expect((await h.json(await h.call('dentA', 'GET', `/v1/visits/${id}`))).voidReason).toBe('wrong patient')
    expect((await h.call('ownerB', 'GET', `/v1/visits/${id}`)).status).toBe(404)
  })
})

describe('quotes', () => {
  it('a new quote supersedes the open one; versions gap-free; answered quotes are frozen; exact totals', async () => {
    const q = (lines: object[]) => h.call('recA', 'POST', `/v1/patients/${pid}/proposals`, { lines })
    const a = await h.json(await q([{ tooth: '11', name: 'Crown', price: '0.1' }, { name: 'Clean', price: 0.2 }])); expect(a.version).toBe(1)
    const rs = await Promise.all([1, 2, 3, 4].map(() => q([{ name: 'X', price: 10 }]))); expect(rs.every((r) => r.status === 201)).toBe(true)
    const l = await h.json(await h.call('recA', 'GET', `/v1/patients/${pid}/proposals`)); expect(l.items.map((x: any) => x.version)).toEqual([5, 4, 3, 2, 1])
    expect(l.items.filter((x: any) => x.status === 'proposed').length).toBe(1); expect(l.items[4].total).toBe(0.3)
    const open = l.items[0].id
    expect((await h.call('recA', 'POST', `/v1/proposals/${open}/decide`, { status: 'accepted' })).status).toBe(204)
    expect((await h.call('recA', 'POST', `/v1/proposals/${open}/decide`, { status: 'declined' })).status).toBe(409)
    expect((await h.call('recA', 'POST', `/v1/proposals/${l.items[1].id}/decide`, { status: 'accepted' })).status).toBe(409) // superseded
    await expect(h.db.run("UPDATE plan_proposal SET total = 1 WHERE id=$1", [open])).rejects.toThrow(); await expect(h.db.run('DELETE FROM plan_proposal')).rejects.toThrow()
    expect((await h.json(await h.call('recA', 'GET', `/v1/patients/${pid}/proposals?limit=2&before=3`))).items.map((x: any) => x.version)).toEqual([2, 1])
  })
  it('validates and isolates', async () => {
    for (const lines of [[], [{ name: 'x', price: '1.005' }], [{ name: '', price: 1 }], [{ name: 'x', price: 1, tooth: '99' }]]) expect((await h.call('recA', 'POST', `/v1/patients/${pid}/proposals`, { lines })).status).toBe(400)
    expect((await h.call('ownerB', 'POST', `/v1/patients/${pid}/proposals`, { lines: [{ name: 'x', price: 1 }] })).status).toBe(404)
    expect((await h.call('acctA', 'POST', `/v1/patients/${pid}/proposals`, { lines: [{ name: 'x', price: 1 }] })).status).toBe(403)
  })
})

describe('medication and allergy lists, patient records', () => {
  let generic: string, brand: string, allergy: string
  it('generic and brand rules; hidden items leave pickers but stay', async () => {
    const post = (b: object, who = 'dentA') => h.call(who, 'POST', '/v1/library/medications', b)
    generic = (await h.json(await post({ kind: 'generic', name: 'Amoxicillin', notes: 'Penicillin class', reviewConditions: ['pregnancy'] }))).id
    brand = (await h.json(await post({ kind: 'brand', name: 'Clamoxyl', genericId: generic }))).id
    for (const bad of [{ kind: 'brand', name: 'x' }, { kind: 'generic', name: 'x', genericId: generic }, { kind: 'brand', name: 'x', genericId: brand }, { kind: 'brand', name: 'x', genericId: '00000000-0000-0000-0000-000000000000' }, { kind: 'other', name: 'x' }]) expect((await post(bad)).status).toBe(400)
    expect((await post({ kind: 'generic', name: 'x' }, 'recA')).status).toBe(403)
    expect((await h.call('dentA', 'PATCH', `/v1/library/medications/${brand}`, { notes: 'no' })).status).toBe(404)
    expect((await h.call('dentA', 'PATCH', `/v1/library/medications/${generic}`, { kind: 'brand' })).status).toBe(400)
    expect((await h.json(await h.call('dentA', 'GET', '/v1/library/medications'))).items.map((x: any) => x.name)).toEqual(['Amoxicillin', 'Clamoxyl'])
    await h.call('dentA', 'PATCH', `/v1/library/medications/${brand}`, { hidden: true })
    expect((await h.json(await h.call('dentA', 'GET', '/v1/library/medications'))).items.length).toBe(1)
    expect((await h.json(await h.call('dentA', 'GET', '/v1/library/medications?hidden=true'))).items.length).toBe(2)
    expect((await h.json(await h.call('ownerB', 'GET', '/v1/library/medications'))).items).toEqual([])
    allergy = (await h.json(await h.call('dentA', 'POST', '/v1/library/allergies', { name: 'Penicillin', medicationId: generic }))).id
  })
  it('patient allergy: duplicate refused, history kept, removal keeps the record', async () => {
    const r = await h.call('dentA', 'POST', `/v1/patients/${pid}/allergies`, { allergyId: allergy, reaction: 'Rash', reactionDate: '2020-05-01' }); expect(r.status).toBe(201); const id = (await h.json(r)).id
    expect((await h.call('dentA', 'POST', `/v1/patients/${pid}/allergies`, { allergyId: allergy })).status).toBe(409)
    expect((await h.call('dentA', 'POST', `/v1/patients/${pid}/allergies`, { allergyId: '00000000-0000-0000-0000-000000000000' })).status).toBe(400)
    expect((await h.call('dentA', 'PATCH', `/v1/patient-allergies/${id}`, { active: false, note: 'tested negative' })).status).toBe(204)
    const l = (await h.json(await h.call('dentA', 'GET', `/v1/patients/${pid}/allergies`))).items; expect(l[0].label).toBe('Penicillin'); expect(l[0].active).toBe(false); expect(l[0].history.map((e: any) => e.what)).toEqual(['added', 'inactive'])
    expect((await h.call('ownerB', 'PATCH', `/v1/patient-allergies/${id}`, { active: true })).status).toBe(404)
    expect((await h.call('dentA', 'DELETE', `/v1/patient-allergies/${id}`, undefined)).status).toBe(204)
    expect((await h.json(await h.call('dentA', 'GET', `/v1/patients/${pid}/allergies`))).items.length).toBe(0)
    expect((await h.db.rows("SELECT 1 FROM patient_record_event WHERE record_id=$1 AND what='removed'", [id])).length).toBe(1)
    await expect(h.db.run('DELETE FROM patient_record_event')).rejects.toThrow()
  })
  it('patient medication: dates validated, history, removal', async () => {
    const post = (b: object) => h.call('dentA', 'POST', `/v1/patients/${pid}/medications`, b)
    expect((await post({ medicationId: generic, start: '2026-02-01', stop: '2026-01-01' })).status).toBe(400)
    expect((await post({ medicationId: generic, source: 'bogus' })).status).toBe(400)
    const id = (await h.json(await post({ medicationId: generic, start: '2026-01-01', source: 'reported' }))).id
    expect((await h.call('dentA', 'PATCH', `/v1/patient-medications/${id}`, { stop: '2026-03-01', active: false })).status).toBe(204)
    const l = (await h.json(await h.call('dentA', 'GET', `/v1/patients/${pid}/medications`))).items; expect(l[0].stop).toBe('2026-03-01'); expect(l[0].history.map((e: any) => e.what)).toEqual(['added', 'stopped'])
    expect((await h.call('dentA', 'DELETE', `/v1/patient-medications/${id}`)).status).toBe(204)
    expect((await h.call('recA', 'GET', `/v1/patients/${pid}/medications`)).status).toBe(403)
  })
})
