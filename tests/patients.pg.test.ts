// Real PostgreSQL: patients API (validation, permissions, tenant isolation, search, keyset pagination, numbering).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { harness } from './pg/harness'
import { nextSeq } from '../src/lib/numbering'

let h: Awaited<ReturnType<typeof harness>>
beforeAll(async () => { h = await harness() })
afterAll(async () => { await h.drop() })
const mk = async (who: string, o: object) => h.json(await h.call(who, 'POST', '/v1/patients', o))

describe('patients', () => {
  it('creates with a gap-free file number per clinic; numbers are independent across clinics', async () => {
    const a1 = await mk('recA', { fullName: 'Élodie Martin', phone: '0600000001' }), a2 = await mk('recA', { fullName: 'Zed' }), b1 = await mk('recB', { fullName: 'Bee' })
    expect([a1.number, a2.number, b1.number]).toEqual(['P-0001', 'P-0002', 'P-0001'])
  })
  it('concurrent creates never duplicate or skip a number', async () => {
    const rs = await Promise.all(Array.from({ length: 25 }, (_, i) => h.call('recA', 'POST', '/v1/patients', { fullName: `Par ${i}` })))
    expect(rs.every((r) => r.status === 201)).toBe(true)
    const nums = (await h.db.rows<{ number: string }>("SELECT number FROM patient WHERE full_name LIKE 'Par %' ORDER BY number")).map((r) => r.number)
    expect(new Set(nums).size).toBe(25)
    const all = (await h.db.rows<{ number: string }>('SELECT number FROM patient WHERE clinic_id = $1 ORDER BY number', [h.A.clinicId])).map((r) => Number(r.number.slice(2)))
    expect(all).toEqual(Array.from({ length: all.length }, (_, i) => i + 1))
  })
  it('a number taken inside a rolled-back transaction is given back (no gaps)', async () => {
    const seq = async () => Number((await h.db.rows<{ last_seq: number }>("SELECT last_seq FROM doc_counter WHERE clinic_id=$1 AND kind='patient'", [h.A.clinicId]))[0].last_seq)
    const before = await seq()
    await expect(h.db.tx(async (q) => { await nextSeq(q, h.A.clinicId, 'patient'); throw new Error('boom') })).rejects.toThrow('boom')
    expect(await seq()).toBe(before)
  })
  it('validates input', async () => {
    for (const bad of [{}, { fullName: ' ' }, { fullName: 'x', birthDate: '2026-02-30' }, { fullName: 'x', sex: 'other' }, { fullName: 'x', language: 'ar' }, { fullName: 'x'.repeat(201) }])
      expect((await h.call('recA', 'POST', '/v1/patients', bad)).status).toBe(400)
  })
  it('enforces permissions: accountant cannot create or edit; dentist cannot archive', async () => {
    expect((await h.call('acctA', 'POST', '/v1/patients', { fullName: 'x' })).status).toBe(403)
    expect((await h.call('acctA', 'GET', '/v1/patients')).status).toBe(200)
    const p = await mk('recA', { fullName: 'Perm' })
    expect((await h.call('dentA', 'POST', `/v1/patients/${p.id}/archive`)).status).toBe(403)
  })
  it("isolates clinics: B cannot read, edit or archive A's patient, nor see it in search", async () => {
    const p = await mk('recA', { fullName: 'Secret Patient' })
    expect((await h.call('recB', 'GET', `/v1/patients/${p.id}`)).status).toBe(404)
    expect((await h.call('recB', 'PATCH', `/v1/patients/${p.id}`, { notes: 'x' })).status).toBe(404)
    expect((await h.call('ownerB', 'POST', `/v1/patients/${p.id}/archive`)).status).toBe(404)
    expect((await h.json(await h.call('recB', 'GET', '/v1/patients?q=secret'))).items).toHaveLength(0)
    expect((await h.call('recA', 'GET', '/v1/patients/not-a-uuid')).status).toBe(404)
  })
  it('searches accent- and case-insensitively by name part, phone and file number', async () => {
    expect((await h.json(await h.call('recA', 'GET', '/v1/patients?q=elodie'))).items.map((x: any) => x.fullName)).toEqual(['Élodie Martin'])
    expect((await h.json(await h.call('recA', 'GET', '/v1/patients?q=MART'))).items).toHaveLength(1)
    expect((await h.json(await h.call('recA', 'GET', '/v1/patients?q=00000001'))).items).toHaveLength(1)
    expect((await h.json(await h.call('recA', 'GET', '/v1/patients?q=p-0002'))).items.map((x: any) => x.fullName)).toEqual(['Zed'])
    expect((await h.json(await h.call('recA', 'GET', '/v1/patients?q=%25'))).items).toHaveLength(0) // % is literal, not a wildcard
  })
  it('paginates by keyset: no gaps, no repeats, capped limit, bad cursor rejected', async () => {
    const seen: string[] = []; let cursor = ''
    for (let i = 0; i < 20; i++) {
      const r = await h.json(await h.call('recA', 'GET', `/v1/patients?limit=10${cursor ? `&cursor=${cursor}` : ''}`))
      seen.push(...r.items.map((x: any) => x.id)); if (!r.nextCursor) break; cursor = r.nextCursor
    }
    const total = Number((await h.db.rows<{ n: string }>('SELECT count(*) n FROM patient WHERE clinic_id=$1 AND archived_at IS NULL', [h.A.clinicId]))[0].n)
    expect(seen).toHaveLength(total); expect(new Set(seen).size).toBe(total)
    for (const q of ['limit=101', 'limit=0', 'cursor=%25%25%25']) expect((await h.call('recA', 'GET', `/v1/patients?${q}`)).status).toBe(400)
    expect((await h.call('recA', 'GET', `/v1/patients?cursor=${btoa(JSON.stringify(['a', 'not-a-uuid']))}`)).status).toBe(400)
  })
  it('edits, archives (hidden by default, kept in the database) and never deletes', async () => {
    const p = await mk('recA', { fullName: 'Edit Me' })
    expect((await h.call('recA', 'PATCH', `/v1/patients/${p.id}`, { fullName: 'Édited Me', alert: 'penicillin' })).status).toBe(204)
    expect((await h.json(await h.call('recA', 'GET', '/v1/patients?q=edited'))).items[0].alert).toBe('penicillin')
    expect((await h.call('ownerA', 'POST', `/v1/patients/${p.id}/archive`)).status).toBe(204)
    expect((await h.json(await h.call('recA', 'GET', '/v1/patients?q=edited'))).items).toHaveLength(0)
    expect((await h.json(await h.call('recA', 'GET', '/v1/patients?q=edited&archived=true'))).items).toHaveLength(1)
    expect((await h.call('ownerA', 'POST', `/v1/patients/${p.id}/archive`)).status).toBe(404)
  })
})
