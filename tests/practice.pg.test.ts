// Real PostgreSQL: expenses, stock ledger (sum of changes always equals quantity, even under races), lab order lifecycle, tasks, implants, sterilization, equipment.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { harness } from './pg/harness'

let h: Awaited<ReturnType<typeof harness>>, pid: string
beforeAll(async () => { h = await harness(); pid = (await h.json(await h.call('recA', 'POST', '/v1/patients', { fullName: 'Lab Patient' }))).id })
afterAll(async () => { await h.drop() })

describe('expenses', () => {
  it('records exact amounts, filters by date range, summarises by category, voids with a reason', async () => {
    const add = (b: object, who = 'ownerA') => h.call(who, 'POST', '/v1/practice/expenses', b)
    expect((await add({ day: '2026-11-02', label: 'Rent', amount: '5000.10', category: 'rent' })).status).toBe(201)
    expect((await add({ day: '2026-11-10', label: 'Gloves', amount: 0.2, category: 'supplies' })).status).toBe(201)
    const v = (await h.json(await add({ day: '2026-11-11', label: 'Oops', amount: 10 }))).id
    for (const bad of [{ day: '2026-02-30', label: 'x', amount: 1 }, { day: '2026-11-01', label: '', amount: 1 }, { day: '2026-11-01', label: 'x', amount: 0 }, { day: '2026-11-01', label: 'x', amount: '1.005' }, { day: '2026-11-01', label: 'x', amount: 1, category: 'bogus' }]) expect((await add(bad)).status).toBe(400)
    expect((await add({ day: '2026-11-01', label: 'x', amount: 1 }, 'acctA')).status).toBe(403) // accountant reads only
    expect((await h.call('ownerA', 'POST', `/v1/practice/expenses/${v}/void`, {})).status).toBe(400)
    expect((await h.call('ownerA', 'POST', `/v1/practice/expenses/${v}/void`, { reason: 'duplicate' })).status).toBe(204)
    const l = await h.json(await h.call('acctA', 'GET', '/v1/practice/expenses?from=2026-11-01&to=2026-11-30')); expect(l.items.map((x: any) => x.label)).toEqual(['Gloves', 'Rent'])
    const s = await h.json(await h.call('acctA', 'GET', '/v1/practice/expenses/summary?from=2026-11-01&to=2026-11-30')); expect(s.total).toBeCloseTo(5000.3, 2)
    expect((await h.call('acctA', 'GET', '/v1/practice/expenses')).status).toBe(400)
    expect((await h.call('acctA', 'GET', '/v1/practice/expenses?from=2020-01-01&to=2026-11-30')).status).toBe(400)
    expect((await h.json(await h.call('ownerB', 'GET', '/v1/practice/expenses?from=2026-11-01&to=2026-11-30'))).items).toEqual([])
    const page1 = await h.json(await h.call('acctA', 'GET', '/v1/practice/expenses?from=2026-11-01&to=2026-11-30&limit=1')); expect(page1.nextCursor).toBeTruthy()
  })
})

describe('stock', () => {
  let item: string
  const move = (b: object, who = 'assistantless') => h.call(who === 'assistantless' ? 'dentA' : who, 'POST', `/v1/practice/stock/${item}/moves`, b)
  it('creating with a quantity writes an opening line; qty cannot be patched directly', async () => {
    item = (await h.json(await h.call('ownerA', 'POST', '/v1/practice/stock', { name: 'Gloves', qty: 10, min: 5, unit: 'box' }))).id
    expect((await h.call('ownerA', 'PATCH', `/v1/practice/stock/${item}`, { qty: 999 })).status).toBe(400)
    expect((await h.call('ownerA', 'PATCH', `/v1/practice/stock/${item}`, { min: 2 })).status).toBe(204)
    const m = await h.json(await h.call('ownerA', 'GET', `/v1/practice/stock/${item}/moves`)); expect(m.items.map((x: any) => [x.kind, x.change, x.after])).toEqual([['opening', 10, 10]])
  })
  it('in/out/waste/adjust follow the rules', async () => {
    expect((await h.json(await move({ kind: 'in', amount: 5 }))).qty).toBe(15)
    expect((await move({ kind: 'out', amount: 100 })).status).toBe(409)
    expect((await move({ kind: 'out', amount: 0 })).status).toBe(422)
    expect((await move({ kind: 'adjust', amount: 3 })).status).toBe(422) // reason needed
    expect((await h.json(await move({ kind: 'adjust', amount: 3, reason: 'recount' }))).qty).toBe(3)
    expect((await move({ kind: 'adjust', amount: 3, reason: 'same' })).status).toBe(422)
    expect((await move({ kind: 'bogus', amount: 1 })).status).toBe(400)
    expect((await h.call('acctA', 'POST', `/v1/practice/stock/${item}/moves`, { kind: 'in', amount: 1 })).status).toBe(403)
    expect((await h.call('ownerB', 'POST', `/v1/practice/stock/${item}/moves`, { kind: 'in', amount: 1 })).status).toBe(404)
  })
  it('40 parallel withdrawals never oversell; ledger sum equals quantity', async () => {
    await move({ kind: 'adjust', amount: 25, reason: 'reset' })
    const rs = await Promise.all(Array.from({ length: 40 }, () => move({ kind: 'out', amount: 1 })))
    expect(rs.filter((r) => r.status === 200).length).toBe(25); expect(rs.filter((r) => r.status === 409).length).toBe(15)
    const [x] = await h.db.rows<{ qty: number; s: string }>('SELECT i.qty, (SELECT sum(change) FROM stock_movement WHERE item_id = i.id) s FROM stock_item i WHERE i.id = $1', [item])
    expect(x.qty).toBe(0); expect(Number(x.s)).toBe(0)
    await expect(h.db.run("UPDATE stock_item SET qty = -1 WHERE id=$1", [item])).rejects.toThrow()
    await expect(h.db.run('DELETE FROM stock_movement')).rejects.toThrow()
  })
  it('lists paged, filters low stock and name, archives', async () => {
    for (const n of ['Anesthetic', 'Burs', 'Cotton']) await h.call('ownerA', 'POST', '/v1/practice/stock', { name: n, qty: 100, min: 1 })
    const a = await h.json(await h.call('ownerA', 'GET', '/v1/practice/stock?limit=2')); expect(a.items.map((x: any) => x.name)).toEqual(['Anesthetic', 'Burs'])
    const b = await h.json(await h.call('ownerA', 'GET', `/v1/practice/stock?limit=2&cursor=${encodeURIComponent(a.nextCursor)}`)); expect(b.items.map((x: any) => x.name)).toEqual(['Cotton', 'Gloves'])
    expect((await h.json(await h.call('ownerA', 'GET', '/v1/practice/stock?low=true'))).items.map((x: any) => x.name)).toEqual(['Gloves'])
    expect((await h.json(await h.call('ownerA', 'GET', '/v1/practice/stock?q=bur'))).items.length).toBe(1)
    expect((await h.json(await h.call('ownerA', 'GET', '/v1/practice/stock?q=%25'))).items.length).toBe(0) // wildcard is literal
    expect((await h.call('ownerA', 'DELETE', `/v1/practice/stock/${item}`)).status).toBe(204)
  })
})

describe('lab orders', () => {
  it('lifecycle: history kept, reasons required, closed orders stay closed', async () => {
    const id = (await h.json(await h.call('dentA', 'POST', '/v1/practice/lab', { patientId: pid, work: 'Crown', lab: 'LabX', due: '2026-12-01', tooth: '36', shade: 'A2', cost: 800 }))).id
    const st = (s: string, note?: string) => h.call('ownerA', 'POST', `/v1/practice/lab/${id}/status`, { status: s, note, day: '2026-11-20' })
    expect((await st('remake')).status).toBe(422); expect((await st('remake', 'wrong shade')).status).toBe(204); expect((await st('remake', 'again')).status).toBe(409)
    expect((await st('ready')).status).toBe(204); expect((await st('fitted')).status).toBe(204)
    expect((await st('sent')).status).toBe(409)
    await expect(h.db.run("UPDATE lab_order SET work='x' WHERE id=$1", [id])).rejects.toThrow()
    const d = await h.json(await h.call('dentA', 'GET', `/v1/practice/lab/${id}`)); expect(d.history.map((e: any) => e.status)).toEqual(['sent', 'remake', 'ready', 'fitted']); expect(d.cost).toBe(800)
    expect((await h.json(await h.call('dentA', 'GET', '/v1/practice/lab?open=true'))).items).toEqual([])
    expect((await h.json(await h.call('dentA', 'GET', `/v1/practice/lab?patientId=${pid}`))).items.length).toBe(1)
  })
  it('validates and isolates', async () => {
    for (const bad of [{ patientId: pid, work: 'x', lab: 'y', due: 'soon' }, { patientId: pid, work: 'x', lab: 'y', due: '2026-12-01', tooth: '99' }, { patientId: 'nope', work: 'x', lab: 'y', due: '2026-12-01' }]) expect([400, 404]).toContain((await h.call('dentA', 'POST', '/v1/practice/lab', bad)).status)
    expect((await h.call('ownerB', 'POST', '/v1/practice/lab', { patientId: pid, work: 'x', lab: 'y', due: '2026-12-01' })).status).toBe(404)
    expect((await h.call('recA', 'GET', '/v1/practice/lab')).status).toBe(403)
  })
})

describe('tasks, implants, sterilization, equipment', () => {
  it('tasks: create, complete, filter, delete', async () => {
    const t = (await h.json(await h.call('recA', 'POST', '/v1/tasks', { text: 'Call lab' }))).id
    expect((await h.call('recA', 'PATCH', `/v1/tasks/${t}`, { done: true })).status).toBe(204)
    expect((await h.json(await h.call('recA', 'GET', '/v1/tasks?done=false'))).items.length).toBe(0)
    expect((await h.json(await h.call('recA', 'GET', '/v1/tasks?done=true'))).items.length).toBe(1)
    expect((await h.call('ownerB', 'DELETE', `/v1/tasks/${t}`)).status).toBe(404); expect((await h.call('recA', 'DELETE', `/v1/tasks/${t}`)).status).toBe(204)
    expect((await h.call('recA', 'POST', '/v1/tasks', { text: ' ' })).status).toBe(400)
  })
  it('implants are traceable by lot and never edited', async () => {
    expect((await h.call('dentA', 'POST', '/v1/practice/implants', { patientId: pid, tooth: '46', brand: 'Straumann', lot: 'L-123', day: '2026-11-10' })).status).toBe(201)
    expect((await h.call('dentA', 'POST', '/v1/practice/implants', { patientId: pid, tooth: '99', brand: 'x', lot: 'y', day: '2026-11-10' })).status).toBe(400)
    expect((await h.json(await h.call('dentA', 'GET', '/v1/practice/implants?lot=L-123'))).items.length).toBe(1)
    expect((await h.json(await h.call('dentA', 'GET', '/v1/practice/implants?lot=nope'))).items.length).toBe(0)
    await expect(h.db.run('DELETE FROM implant_record')).rejects.toThrow()
  })
  it('sterilization cycles are logged newest first and never edited', async () => {
    for (const d of ['2026-11-01', '2026-11-03']) expect((await h.call('dentA', 'POST', '/v1/practice/sterilization', { day: d, device: 'Autoclave 1', lot: 'S1', operator: 'Sam' })).status).toBe(201)
    expect((await h.json(await h.call('dentA', 'GET', '/v1/practice/sterilization'))).items.map((x: any) => x.day)).toEqual(['2026-11-03', '2026-11-01'])
    await expect(h.db.run("UPDATE sterilization_cycle SET lot='x'")).rejects.toThrow()
  })
  it('equipment: service log moves lastService forward only', async () => {
    const e = (await h.json(await h.call('ownerA', 'POST', '/v1/practice/equipment', { name: 'Autoclave', everyMonths: 6 }))).id
    expect((await h.call('ownerA', 'POST', `/v1/practice/equipment/${e}/services`, { day: '2026-06-01', note: 'checked' })).status).toBe(201)
    expect((await h.call('ownerA', 'POST', `/v1/practice/equipment/${e}/services`, { day: '2026-03-01' })).status).toBe(201) // back-dated entry
    expect((await h.json(await h.call('ownerA', 'GET', '/v1/practice/equipment'))).items[0].lastService).toBe('2026-06-01')
    expect((await h.json(await h.call('ownerA', 'GET', `/v1/practice/equipment/${e}/services`))).items.map((x: any) => x.day)).toEqual(['2026-06-01', '2026-03-01'])
    expect((await h.call('ownerA', 'PATCH', `/v1/practice/equipment/${e}`, { everyMonths: 0 })).status).toBe(400)
    expect((await h.call('ownerB', 'POST', `/v1/practice/equipment/${e}/services`, { day: '2026-06-01' })).status).toBe(404)
  })
})
