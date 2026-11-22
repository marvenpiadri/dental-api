// Real PostgreSQL: boundary cases the feature tests don't pin down (exact page edges, oversized bodies, concurrent clinical saves).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { harness } from './pg/harness'

let h: Awaited<ReturnType<typeof harness>>, pid: string
beforeAll(async () => { h = await harness(); pid = (await h.json(await h.call('recA', 'POST', '/v1/patients', { fullName: 'Edge Patient' }))).id })
afterAll(async () => { await h.drop() })

describe('pagination boundaries', () => {
  it('limit=1 and limit=100 are accepted; exactly one full page has no next cursor; an empty result is a valid page', async () => {
    for (let i = 0; i < 4; i++) await h.call('recB', 'POST', '/v1/patients', { fullName: `Page ${i}` }) // clinic B: 1 seeded elsewhere + 4 here
    const total = Number((await h.db.rows<{ n: string }>('SELECT count(*) n FROM patient WHERE clinic_id=$1 AND archived_at IS NULL', [h.B.clinicId]))[0].n)
    const one = await h.json(await h.call('recB', 'GET', '/v1/patients?limit=1')); expect(one.items).toHaveLength(1); expect(one.nextCursor).toBeTruthy()
    const exact = await h.json(await h.call('recB', 'GET', `/v1/patients?limit=${total}`)); expect(exact.items).toHaveLength(total); expect(exact.nextCursor).toBeNull()
    const big = await h.call('recB', 'GET', '/v1/patients?limit=100'); expect(big.status).toBe(200)
    const none = await h.json(await h.call('recB', 'GET', '/v1/patients?q=zzzznomatch')); expect(none.items).toEqual([]); expect(none.nextCursor).toBeNull()
  })
  it('rejects malformed limits instead of widening them', async () => {
    for (const q of ['limit=-1', 'limit=1.5', 'limit=abc', 'limit=10000', 'limit=%20']) expect((await h.call('recA', 'GET', `/v1/patients?${q}`)).status, q).toBe(400)
  })
  it('a cursor from one clinic reveals nothing from another', async () => {
    const a = await h.json(await h.call('recA', 'GET', '/v1/patients?limit=1')), b = await h.json(await h.call('recB', 'GET', `/v1/patients?limit=50&cursor=${a.nextCursor ?? ''}`))
    const idsA = new Set((await h.db.rows<{ id: string }>('SELECT id FROM patient WHERE clinic_id=$1', [h.A.clinicId])).map((r) => r.id))
    expect(b.items.every((x: any) => !idsA.has(x.id))).toBe(true)
  })
})

describe('oversized and malformed payloads', () => {
  it('a body over the 64 KB cap is 413 and nothing is written', async () => {
    const big = JSON.stringify({ fullName: 'x'.repeat(70_000) })
    expect((await h.raw('recA', 'POST', '/v1/patients', big, { 'content-type': 'application/json' })).status).toBe(413)
    expect(Number((await h.db.rows<{ n: string }>("SELECT count(*) n FROM patient WHERE full_name LIKE 'xxxx%'"))[0].n)).toBe(0)
  })
  it('a big medical history is refused with a 4xx (never a 500) and leaves the stored version alone', async () => {
    const r = await h.call('dentA', 'PUT', `/v1/patients/${pid}/medical`, { expectedVersion: 0, conditions: Array.from({ length: 5000 }, (_, i) => `c${i}`) })
    expect(r.status).toBeGreaterThanOrEqual(400); expect(r.status).toBeLessThan(500)
    expect((await h.json(await h.call('dentA', 'GET', `/v1/patients/${pid}/medical`))).version).toBe(0)
  })
  it('malformed JSON and wrong content type are client errors', async () => {
    expect((await h.raw('recA', 'POST', '/v1/patients', '{nope', { 'content-type': 'application/json' })).status).toBe(400)
    expect((await h.raw('recA', 'POST', '/v1/patients', 'fullName=x', { 'content-type': 'text/plain' })).status).toBeGreaterThanOrEqual(400)
  })
})

describe('concurrent clinical saves', () => {
  it('N simultaneous medical saves from the same version: exactly one wins, the rest 409, one revision row', async () => {
    const save = (i: number) => h.call('dentA', 'PUT', `/v1/patients/${pid}/medical`, { expectedVersion: 0, conditions: [`race${i}`] })
    const rs = await Promise.all([1, 2, 3, 4, 5, 6].map(save))
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409, 409])
    const m = await h.json(await h.call('dentA', 'GET', `/v1/patients/${pid}/medical`)); expect(m.version).toBe(1); expect(m.conditions).toHaveLength(1)
    expect(Number((await h.db.rows<{ n: string }>('SELECT count(*) n FROM medical_revision WHERE patient_id=$1', [pid]))[0].n)).toBe(1)
  })
  it('a chain of saves from two staff interleaved never loses an update or skips a version', async () => {
    let v = 1
    for (let round = 0; round < 3; round++) {
      const rs = await Promise.all(['dentA', 'ownerA'].map((who) => h.call(who, 'PUT', `/v1/patients/${pid}/medical`, { expectedVersion: v, conditions: [`${who}-${round}`] })))
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409]); v++
    }
    const revs = await h.db.rows<{ version: number }>('SELECT version FROM medical_revision WHERE patient_id=$1 ORDER BY version', [pid])
    expect(revs.map((r) => r.version)).toEqual([1, 2, 3, 4])
  })
})
