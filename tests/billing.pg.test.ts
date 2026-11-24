// Real PostgreSQL: invoices, credit notes, payments, refunds: exact money, gap-free numbering, immutability triggers, races, isolation.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { harness } from './pg/harness'

let h: Awaited<ReturnType<typeof harness>>, pid: string, pidB: string
const line = (label: string, price: string) => ({ label, price })
const inv = async (lines: object[], who = 'acctA', patient = () => pid) => h.call(who, 'POST', `/v1/patients/${patient()}/invoices`, { lines })
const pay = (o: object, who = 'acctA') => h.call(who, 'POST', `/v1/patients/${pid}/payments`, { method: 'cash', ...o })
const bal = async () => h.json(await h.call('acctA', 'GET', `/v1/patients/${pid}/balance`))

beforeAll(async () => {
  h = await harness()
  pid = (await h.json(await h.call('recA', 'POST', '/v1/patients', { fullName: 'Bill Me' }))).id
  pidB = (await h.json(await h.call('recB', 'POST', '/v1/patients', { fullName: 'B patient' }))).id
})
afterAll(async () => { await h.drop() })

describe('invoices', () => {
  it('issues FA-year-seq numbers, exact totals (0.1 + 0.2), with lines in order', async () => {
    const r = await inv([line('Filling', '0.10'), line('Cleaning', '0.20')]); expect(r.status).toBe(201)
    const { id, number } = await h.json(r); expect(number).toBe('FA-2026-0001')
    const d = await h.json(await h.call('acctA', 'GET', `/v1/invoices/${id}`))
    expect(d.total).toBe('0.30'); expect(d.lines.map((l: any) => l.label)).toEqual(['Filling', 'Cleaning']); expect(d.currency).toBe('MAD')
  })
  it('validates lines, amounts and permissions', async () => {
    for (const bad of [[], [line('x', '1.005')], [line('', '1')], [line('x', 'abc')]]) expect((await inv(bad)).status).toBe(400)
    expect((await inv([line('x', '-5')])).status).toBe(422) // negative prices belong on credit notes only
    expect((await inv([line('x', '1')], 'recA')).status).toBe(201) // reception has billing.create
    expect((await inv([line('x', '1')], 'dentA')).status).toBe(403)
  })
  it('30 simultaneous issues produce unique, gap-free numbers', async () => {
    const rs = await Promise.all(Array.from({ length: 30 }, () => inv([line('P', '10')])))
    expect(rs.every((r) => r.status === 201)).toBe(true)
    const seqs = (await h.db.rows<{ seq: number }>("SELECT seq FROM invoice WHERE clinic_id=$1 AND kind='invoice' ORDER BY seq", [h.A.clinicId])).map((r) => r.seq)
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1))
  })
  it('a failure after the number is taken rolls the number back (no gap)', async () => {
    const before = Number((await h.db.rows<{ n: string }>("SELECT last_seq n FROM doc_counter WHERE clinic_id=$1 AND kind='invoice'", [h.A.clinicId]))[0].n)
    const { issueInvoice } = await import('../src/billing/service')
    await expect(issueInvoice(h.db, { clinicId: h.A.clinicId, patientId: crypto.randomUUID(), lines: [line('x', '1')], now: Date.now(), tz: 'UTC', currency: 'MAD', staffId: null })).rejects.toThrow() // unknown patient: FK
    expect(Number((await h.db.rows<{ n: string }>("SELECT last_seq n FROM doc_counter WHERE clinic_id=$1 AND kind='invoice'", [h.A.clinicId]))[0].n)).toBe(before)
  })
  it('issued invoices and lines cannot be changed or deleted, even by direct SQL', async () => {
    const { id } = await h.json(await inv([line('Locked', '50')]))
    await expect(h.db.run('UPDATE invoice SET total = 1 WHERE id = $1', [id])).rejects.toThrow(/cannot be changed/)
    await expect(h.db.run('DELETE FROM invoice WHERE id = $1', [id])).rejects.toThrow(/append-only/)
    await expect(h.db.run('UPDATE invoice_line SET price = 1 WHERE invoice_id = $1', [id])).rejects.toThrow(/append-only/)
    await expect(h.db.run('DELETE FROM invoice_line WHERE invoice_id = $1', [id])).rejects.toThrow(/append-only/)
  })
  it("isolates clinics: B cannot read, bill or cancel A's patient or invoice", async () => {
    const { id } = await h.json(await inv([line('x', '5')]))
    expect((await h.call('recB', 'GET', `/v1/invoices/${id}`)).status).toBe(404)
    expect((await h.call('recB', 'POST', `/v1/patients/${pid}/invoices`, { lines: [line('x', '1')] })).status).toBe(404)
    expect((await h.call('ownerB', 'POST', `/v1/invoices/${id}/cancel`, { reason: 'x' })).status).toBe(404)
    expect((await h.call('recB', 'GET', `/v1/patients/${pid}/invoices`)).status).toBe(404)
  })
})

describe('cancel = credit note', () => {
  it('cancels once, issues AV-… with negated lines; a second cancel is 409; 10 parallel cancels yield exactly one credit note', async () => {
    const { id } = await h.json(await inv([line('Crown', '300'), line('X-ray', '20.50')]))
    const rs = await Promise.all(Array.from({ length: 10 }, () => h.call('ownerA', 'POST', `/v1/invoices/${id}/cancel`, { reason: 'error' })))
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1); expect(rs.filter((r) => r.status === 409)).toHaveLength(9)
    const note = await h.json(rs.find((r) => r.status === 201)!)
    expect(note.number).toMatch(/^AV-2026-\d{4}$/)
    const d = await h.json(await h.call('acctA', 'GET', `/v1/invoices/${note.id}`))
    expect(d.total).toBe('-320.50'); expect(d.cancelsId).toBe(id); expect(d.lines.map((l: any) => l.price)).toEqual(['-300.00', '-20.50'])
    expect((await h.json(await h.call('acctA', 'GET', `/v1/invoices/${id}`))).cancelReason).toBe('error')
  })
  it('only billing.void may cancel; a credit note cannot be cancelled; a reason is required', async () => {
    const { id } = await h.json(await inv([line('x', '5')]))
    expect((await h.call('recA', 'POST', `/v1/invoices/${id}/cancel`, { reason: 'x' })).status).toBe(403)
    expect((await h.call('ownerA', 'POST', `/v1/invoices/${id}/cancel`, {})).status).toBe(400)
    const note = await h.json(await h.call('ownerA', 'POST', `/v1/invoices/${id}/cancel`, { reason: 'x' }))
    expect((await h.call('ownerA', 'POST', `/v1/invoices/${note.id}/cancel`, { reason: 'x' })).status).toBe(422)
  })
})

describe('payments, balance, refunds', () => {
  it('records payments, rejects bad ones, settles only an open invoice, never cross-clinic', async () => {
    const { id } = await h.json(await inv([line('Whitening', '100')]))
    expect((await pay({ amount: 0 })).status).toBe(400); expect((await pay({ amount: 5, method: 'bitcoin' })).status).toBe(400); expect((await pay({ amount: '1.234' })).status).toBe(400)
    expect((await pay({ amount: 40, invoiceId: id })).status).toBe(201)
    expect((await h.call('recB', 'POST', `/v1/patients/${pidB}/payments`, { amount: 5, method: 'cash', invoiceId: id })).status).toBe(404)
    await h.call('ownerA', 'POST', `/v1/invoices/${id}/cancel`, { reason: 'x' })
    expect((await pay({ amount: 10, invoiceId: id })).status).toBe(422)
  })
  it('balance is exact: billed - (payments - refunds); voided payments drop out', async () => {
    const p = await h.json(await h.call('recA', 'POST', '/v1/patients', { fullName: 'Fresh' })), fid = p.id
    const mkInv = async (price: string) => h.json(await h.call('acctA', 'POST', `/v1/patients/${fid}/invoices`, { lines: [line('w', price)] }))
    const a = await mkInv('100.10')
    const paid = await h.json(await h.call('acctA', 'POST', `/v1/patients/${fid}/payments`, { amount: '60.05', method: 'card', invoiceId: a.id }))
    let b = await h.json(await h.call('acctA', 'GET', `/v1/patients/${fid}/balance`)); expect(b).toMatchObject({ billed: '100.10', paid: '60.05', due: '40.05' })
    expect((await h.call('acctA', 'POST', `/v1/payments/${paid.id}/void`, { reason: 'typo' })).status).toBe(204)
    expect((await h.call('acctA', 'POST', `/v1/payments/${paid.id}/void`, { reason: 'again' })).status).toBe(404)
    b = await h.json(await h.call('acctA', 'GET', `/v1/patients/${fid}/balance`)); expect(b).toMatchObject({ paid: '0.00', due: '100.10' })
    await expect(h.db.run('UPDATE payment SET amount = 1 WHERE id = $1', [paid.id])).rejects.toThrow(/voided/)
    await expect(h.db.run('DELETE FROM payment WHERE id = $1', [paid.id])).rejects.toThrow(/append-only/)
  })
  it('refunds: against the credit note, capped at what was paid, concurrent refunds cannot exceed it, they reduce "paid"', async () => {
    const fid = (await h.json(await h.call('recA', 'POST', '/v1/patients', { fullName: 'Refund Me' }))).id
    const i = await h.json(await h.call('acctA', 'POST', `/v1/patients/${fid}/invoices`, { lines: [line('Crown', '200')] }))
    await h.call('acctA', 'POST', `/v1/patients/${fid}/payments`, { amount: 120, method: 'cash', invoiceId: i.id })
    const note = await h.json(await h.call('ownerA', 'POST', `/v1/invoices/${i.id}/cancel`, { reason: 'redo' }))
    const rf = (amount: number, id = note.id) => h.call('ownerA', 'POST', `/v1/invoices/${id}/refunds`, { amount, method: 'cash' })
    expect((await rf(0)).status).toBe(400); expect((await rf(150)).status).toBe(422)
    expect((await h.call('ownerA', 'POST', `/v1/invoices/${i.id}/refunds`, { amount: 5, method: 'cash' })).status).toBe(422) // not a credit note
    const rs = await Promise.all(Array.from({ length: 6 }, () => rf(50)))
    expect(rs.filter((r) => r.status === 201)).toHaveLength(2); expect(rs.filter((r) => r.status === 422)).toHaveLength(4) // 120 allows two of 50
    const d = await h.json(await h.call('acctA', 'GET', `/v1/invoices/${note.id}`)); expect(d.refunds).toHaveLength(2)
    expect(await h.json(await h.call('acctA', 'GET', `/v1/patients/${fid}/balance`))).toMatchObject({ billed: '0.00', paid: '20.00', due: '-20.00' })
    expect((await rf(20)).status).toBe(201)
    expect(await h.json(await h.call('acctA', 'GET', `/v1/patients/${fid}/balance`))).toMatchObject({ paid: '0.00', due: '0.00' })
    await expect(h.db.run('UPDATE refund SET amount = 1')).rejects.toThrow(/append-only/)
  })
  it('lists invoices and payments newest first with keyset pagination, no gaps', async () => {
    const seen: string[] = []; let cursor = ''
    for (let i = 0; i < 30; i++) { const r = await h.json(await h.call('acctA', 'GET', `/v1/patients/${pid}/invoices?limit=7${cursor ? `&cursor=${cursor}` : ''}`)); seen.push(...r.items.map((x: any) => x.id)); if (!r.nextCursor) break; cursor = r.nextCursor }
    const total = Number((await h.db.rows<{ n: string }>('SELECT count(*) n FROM invoice WHERE patient_id=$1', [pid]))[0].n)
    expect(seen).toHaveLength(total); expect(new Set(seen).size).toBe(total)
    expect((await h.call('acctA', 'GET', `/v1/patients/${pid}/invoices?limit=101`)).status).toBe(400)
    expect((await h.call('acctA', 'GET', `/v1/patients/${pid}/payments?cursor=%25%25`)).status).toBe(400)
  })
  it('withLines returns lines and refunds in one bounded page', async () => {
    const r = await h.json(await h.call('acctA', 'GET', `/v1/patients/${pid}/invoices?limit=5&withLines=true`))
    expect(r.items).toHaveLength(5); for (const i of r.items) { expect(i.lines.length).toBeGreaterThan(0); expect(i.total).toMatch(/^-?\d+\.\d\d$/) }
    expect(r.items.some((i: any) => i.kind === 'credit-note' && Array.isArray(i.refunds))).toBe(true)
    expect((await h.call('acctA', 'GET', `/v1/patients/${pid}/invoices?limit=51&withLines=true`)).status).toBe(400)
    expect((await h.call('recB', 'GET', `/v1/patients/${pid}/invoices?withLines=true`)).status).toBe(404)
  })
})
