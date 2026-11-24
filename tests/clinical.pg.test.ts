// Real PostgreSQL: medical history, the chart (per-tooth revisions, no whole overwrite), exams, restore, treatment plan, isolation.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { harness, NOW } from './pg/harness'

let h: Awaited<ReturnType<typeof harness>>, pid: string, pidB: string
const P = (s = '') => `/v1/patients/${pid}${s}`
const patch = (changes: object[], extra: object = {}, who = 'dentA') => h.call(who, 'PATCH', P('/chart'), { changes, ...extra })
const chart = async () => h.json(await h.call('dentA', 'GET', P('/chart')))

beforeAll(async () => {
  h = await harness()
  pid = (await h.json(await h.call('recA', 'POST', '/v1/patients', { fullName: 'Chart Patient' }))).id
  pidB = (await h.json(await h.call('recB', 'POST', '/v1/patients', { fullName: 'B patient' }))).id
})
afterAll(async () => { await h.drop() })

describe('medical history', () => {
  it('starts empty, saves with expectedVersion, refuses a stale save, keeps the previous content', async () => {
    expect((await h.json(await h.call('dentA', 'GET', P('/medical')))).version).toBe(0)
    expect((await h.call('dentA', 'PUT', P('/medical'), { expectedVersion: 0, conditions: ['asthma'], allergies: 'penicillin' })).status).toBe(200)
    expect((await h.call('dentA', 'PUT', P('/medical'), { expectedVersion: 0, conditions: [] })).status).toBe(409)
    expect((await h.call('dentA', 'PUT', P('/medical'), { expectedVersion: 1, conditions: ['asthma', 'diabetes'], allergies: 'penicillin' })).status).toBe(200)
    const m = await h.json(await h.call('dentA', 'GET', P('/medical'))); expect(m.version).toBe(2); expect(m.conditions).toEqual(['asthma', 'diabetes'])
    const revs = await h.db.rows<{ version: number; before: any }>('SELECT version, before FROM medical_revision WHERE patient_id=$1 ORDER BY version', [pid])
    expect(revs.map((r) => r.version)).toEqual([1, 2]); expect(revs[1].before.conditions).toEqual(['asthma'])
  })
  it('reception cannot edit; other clinic sees 404', async () => {
    expect((await h.call('recA', 'PUT', P('/medical'), { expectedVersion: 2 })).status).toBe(403)
    expect((await h.call('ownerB', 'GET', P('/medical'))).status).toBe(404)
  })
})

describe('chart', () => {
  it('has no chart until created; PATCH before that is 404; init validates', async () => {
    expect((await chart()).chart).toBeNull()
    expect((await patch([{ scope: 'teeth', tooth: '11', expectedRev: 0, set: { status: 'x' } }])).status).toBe(404)
    expect((await h.call('dentA', 'POST', P('/chart'), { chart: { version: 'x' } })).status).toBe(422)
    expect((await h.call('dentA', 'POST', P('/chart'), { chart: { version: '2.22', teeth: { '99': {} } } })).status).toBe(422)
    const r = await h.call('dentA', 'POST', P('/chart'), { chart: { version: '2.22', globals: { edentulous: false }, teeth: { '11': { status: 'present', perio: { pd: [3, 3, 4] } }, '12': { status: 'missing' } } } })
    expect(r.status).toBe(201); const c = await h.json(r); expect(c.revs.teeth['11']).toBe(1)
    expect((await h.call('dentA', 'POST', P('/chart'), { chart: { version: '2.22', teeth: {} } })).status).toBe(409) // cannot re-init
  })
  it('patches one tooth, bumps only that rev, and the perio field does not touch odontogram fields', async () => {
    const before = await chart()
    const r = await patch([{ scope: 'teeth', tooth: '11', expectedRev: before.revs.teeth['11'], set: { perio: { pd: [4, 4, 4] } } }]); expect(r.status).toBe(200)
    const after = await chart()
    expect(after.chart.teeth['11'].status).toBe('present'); expect(after.chart.teeth['11'].perio.pd).toEqual([4, 4, 4])
    expect(after.revs.teeth['11']).toBe(before.revs.teeth['11'] + 1); expect(after.revs.teeth['12']).toBe(before.revs.teeth['12'])
  })
  it('refuses stale revisions and leaves everything unchanged (atomic multi-change)', async () => {
    const c = await chart()
    const r = await patch([{ scope: 'teeth', tooth: '12', expectedRev: c.revs.teeth['12'], set: { note: 'a' } }, { scope: 'teeth', tooth: '11', expectedRev: 1, set: { note: 'b' } }])
    expect(r.status).toBe(409)
    expect((await chart()).chart.teeth['12'].note).toBeUndefined()
  })
  it('rejects empty, ambiguous and oversized changes; destructive ones need a reason; clear needs a reason', async () => {
    const c = await chart(), rv = c.revs.teeth['11']
    for (const bad of [[], [{ scope: 'teeth', tooth: '11', expectedRev: rv }], [{ scope: 'teeth', tooth: '11', expectedRev: rv, set: {}, }], [{ scope: 'teeth', tooth: '11', expectedRev: rv, set: { a: 1 }, unset: ['b'] }], [{ scope: 'teeth', tooth: '19', expectedRev: 0, set: { a: 1 } }]])
      expect([400, 422]).toContain((await patch(bad as object[])).status)
    expect((await patch([{ scope: 'teeth', tooth: '11', expectedRev: rv, replace: { status: 'present' } }])).status).toBe(422) // drops perio, no reason
    expect((await patch([{ scope: 'teeth', tooth: '11', expectedRev: rv, clear: true }])).status).toBe(422)
    expect((await chart()).chart.teeth['11'].perio).toBeDefined()
    expect((await patch([{ scope: 'teeth', tooth: '11', expectedRev: rv, replace: { status: 'present' } }], { reason: 'entered on wrong patient' })).status).toBe(200)
  })
  it('parallel edits: same tooth one wins, different teeth both succeed', async () => {
    const c = await chart(), r12 = c.revs.teeth['12']
    const same = await Promise.all([1, 2, 3, 4, 5].map((i) => patch([{ scope: 'teeth', tooth: '12', expectedRev: r12, set: { n: i } }])))
    expect(same.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409])
    const c2 = await chart()
    const both = await Promise.all([
      patch([{ scope: 'teeth', tooth: '21', expectedRev: 0, set: { status: 'present' } }]),
      patch([{ scope: 'teeth', tooth: '22', expectedRev: 0, set: { status: 'present' } }]),
    ])
    expect(both.map((r) => r.status)).toEqual([200, 200]); expect(c2.revs.teeth['21']).toBeUndefined()
  })
  it('logs every change with before/after and history is paged without bodies', async () => {
    const h1 = await h.json(await h.call('dentA', 'GET', P('/chart/history?limit=2&tooth=11')))
    expect(h1.items.length).toBe(2); expect(h1.items[0].before).toBeUndefined(); expect(h1.nextCursor).toBeTruthy()
    const d = await h.json(await h.call('dentA', 'GET', P(`/chart/revisions/${h1.items[0].id}`))); expect(d.after).toBeTruthy()
    expect((await h.call('dentA', 'GET', P('/chart/history?cursor=bad'))).status).toBe(400)
    expect((await h.call('dentA', 'GET', P('/chart/history?limit=101'))).status).toBe(400)
  })
  it('the database refuses deleting or editing revisions', async () => {
    await expect(h.db.run('DELETE FROM chart_revision WHERE patient_id=$1', [pid])).rejects.toThrow()
    await expect(h.db.run("UPDATE chart_revision SET reason='x' WHERE patient_id=$1", [pid])).rejects.toThrow()
  })
  it('permissions and isolation', async () => {
    expect((await patch([{ scope: 'teeth', tooth: '31', expectedRev: 0, set: { a: 1 } }], {}, 'recA')).status).toBe(403)
    expect((await h.call('ownerB', 'GET', P('/chart'))).status).toBe(404)
    expect((await patch([{ scope: 'teeth', tooth: '31', expectedRev: 0, set: { a: 1 } }], {}, 'ownerB')).status).toBe(404)
  })
})

describe('exams and restore', () => {
  let examId: string
  it('exam snapshots the stored chart; the client cannot supply one; it is immutable', async () => {
    const r = await h.call('dentA', 'POST', P('/exams'), { note: 'baseline', chart: { version: '1.0', teeth: {} } }); expect(r.status).toBe(201)
    examId = (await h.json(r)).id
    const e = await h.json(await h.call('dentA', 'GET', `/v1/exams/${examId}`)); expect(e.chart.teeth['12']).toBeDefined(); expect(e.chart.version).toBe('2.22')
    await expect(h.db.run("UPDATE exam SET note='x' WHERE id=$1", [examId])).rejects.toThrow()
    await expect(h.db.run('DELETE FROM exam WHERE id=$1', [examId])).rejects.toThrow()
    expect((await h.call('ownerB', 'GET', `/v1/exams/${examId}`)).status).toBe(404)
  })
  it('restore needs clinical.void and a reason, and writes new revisions instead of rewriting history', async () => {
    const c = await chart(); await patch([{ scope: 'teeth', tooth: '12', expectedRev: c.revs.teeth['12'], set: { status: 'wrong' } }])
    expect((await h.call('dentA', 'POST', P('/chart/restore'), { examId })).status).toBe(400)
    const n = Number((await h.db.rows<{ n: string }>('SELECT count(*) n FROM chart_revision WHERE patient_id=$1', [pid]))[0].n)
    const r = await h.call('ownerA', 'POST', P('/chart/restore'), { examId, reason: 'wrong entry' }); expect(r.status).toBe(200)
    expect((await chart()).chart.teeth['12'].status).toBe('missing')
    expect(Number((await h.db.rows<{ n: string }>('SELECT count(*) n FROM chart_revision WHERE patient_id=$1', [pid]))[0].n)).toBeGreaterThan(n)
    expect((await h.call('recA', 'POST', P('/chart/restore'), { examId, reason: 'x y z' })).status).toBe(403)
  })
  it('lists exams paged and voids with a reason', async () => {
    const l = await h.json(await h.call('dentA', 'GET', P('/exams?limit=5'))); expect(l.items.length).toBe(1)
    expect((await h.call('ownerA', 'POST', `/v1/exams/${examId}/void`, {})).status).toBe(400)
    expect((await h.call('ownerA', 'POST', `/v1/exams/${examId}/void`, { reason: 'mistake' })).status).toBe(204)
  })
  it('lists exams with their frozen charts (capped at 10 then), oldest first on request, and rejects bad paging', async () => {
    const w = await h.json(await h.call('dentA', 'GET', P('/exams?withCharts=true&limit=10')))
    expect(w.items[0].chart.teeth).toBeTruthy()
    expect((await h.call('dentA', 'GET', P('/exams?withCharts=true&limit=11'))).status).toBe(400)
    expect((await h.call('dentA', 'GET', P('/exams?order=sideways'))).status).toBe(400)
    expect((await h.json(await h.call('dentA', 'GET', P('/exams?order=asc&limit=1')))).items).toHaveLength(1)
    expect((await h.json(await h.call('dentA', 'GET', P('/exams')))).items[0]).not.toHaveProperty('chart') // the plain list stays light
  })
  it('an exam of another clinic patient is 404', async () => {
    expect((await h.call('ownerB', 'POST', P('/exams'), {})).status).toBe(404)
  })
})

describe('treatment plan', () => {
  it('creates, lists paged, edits while planned, freezes when done', async () => {
    const r = await h.call('dentA', 'POST', P('/plan'), { tooth: '11', procedure: 'filling', price: '300' }); expect(r.status).toBe(201)
    const { id } = await h.json(r)
    await h.call('dentA', 'POST', P('/plan'), { scope: 'quadrant', quadrant: 2, procedure: 'scaling', price: 150.5 })
    const l = await h.json(await h.call('dentA', 'GET', P('/plan?limit=1'))); expect(l.items.length).toBe(1); expect(l.nextCursor).toBeTruthy()
    expect((await h.call('dentA', 'PATCH', `/v1/plan/${id}`, { price: '320.00' })).status).toBe(204)
    expect((await h.call('dentA', 'PATCH', `/v1/plan/${id}`, { status: 'done' })).status).toBe(204)
    expect((await h.call('dentA', 'PATCH', `/v1/plan/${id}`, { price: '1' })).status).toBe(409)
    expect((await h.call('dentA', 'DELETE', `/v1/plan/${id}`)).status).toBe(409)
    const [row] = await h.db.rows<{ price: string }>('SELECT price FROM treatment_item WHERE id=$1', [id]); expect(row.price).toBe('320.00')
    await expect(h.db.run("UPDATE treatment_item SET price=1 WHERE id=$1", [id])).rejects.toThrow()
  })
  it('records finished work in one step with its own day; refuses a future day, a bad status and another patient\'s visit', async () => {
    const day = new Date(NOW - 3 * 864e5).toISOString().slice(0, 10) // the harness clock is fixed
    const r = await h.call('dentA', 'POST', P('/plan'), { tooth: '16', procedure: 'filling', price: '400', status: 'done', date: day }); expect(r.status).toBe(201)
    const id = (await h.json(r)).id
    const [row] = await h.db.rows<{ status: string; done_date: string; done_at: string | null }>('SELECT status, done_date::text, done_at FROM treatment_item WHERE id=$1', [id])
    expect(row.status).toBe('done'); expect(row.done_date).toBe(day); expect(row.done_at).toBeTruthy()
    expect((await h.call('dentA', 'PATCH', `/v1/plan/${id}`, { price: '1' })).status).toBe(409) // frozen like any done item
    const future = new Date(NOW + 3 * 864e5).toISOString().slice(0, 10)
    expect((await h.call('dentA', 'POST', P('/plan'), { tooth: '16', procedure: 'x', price: '1', status: 'done', date: future })).status).toBe(400)
    expect((await h.call('dentA', 'POST', P('/plan'), { tooth: '16', procedure: 'x', price: '1', status: 'done', date: 'yesterday' })).status).toBe(400)
    expect((await h.call('dentA', 'POST', P('/plan'), { tooth: '16', procedure: 'x', price: '1', status: 'void' })).status).toBe(400)
    expect((await h.call('dentA', 'POST', P('/plan'), { tooth: '16', procedure: 'x', price: '1', status: 'done', appointmentId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404)
  })
  it('validates input and isolates clinics', async () => {
    for (const bad of [{ tooth: '99', procedure: 'x', price: '1' }, { procedure: 'x', price: '1.005' }, { tooth: '11', price: '1' }, { scope: 'quadrant', procedure: 'x', price: '1' }])
      expect((await h.call('dentA', 'POST', P('/plan'), bad)).status).toBe(400)
    expect((await h.call('ownerB', 'POST', P('/plan'), { procedure: 'x', price: '1' })).status).toBe(404)
    const id = (await h.db.rows<{ id: string }>('SELECT id FROM treatment_item WHERE patient_id=$1 LIMIT 1', [pid]))[0].id
    expect((await h.call('ownerB', 'PATCH', `/v1/plan/${id}`, { price: '5' })).status).toBe(404)
    expect((await h.call('ownerB', 'GET', P('/plan'))).status).toBe(404)
  })
})
