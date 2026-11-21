// Real PostgreSQL: report aggregates (exact, clinic zone/currency, scoped), duplicate detection and merge (moves what may move, refuses what may not).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { harness } from './pg/harness'

let h: Awaited<ReturnType<typeof harness>>, p1: string, p2: string, dent: string, chair: string
const iso = (hh: number, day = 16) => new Date(Date.UTC(2026, 10, day, hh)).toISOString()
const mk = async (who: string, path: string, o: object) => (await h.json(await h.call(who, 'POST', path, o))).id as string
beforeAll(async () => {
  h = await harness()
  p1 = await mk('recA', '/v1/patients', { fullName: 'Karim Alaoui', phone: '0612 345 678', birthDate: '1985-03-02' }); p2 = await mk('recA', '/v1/patients', { fullName: 'Ana Pérez' })
  dent = await mk('ownerA', '/v1/dentists', { name: 'Dr R' }); chair = await mk('ownerA', '/v1/chairs', { name: 'C1' })
})
afterAll(async () => { await h.drop() })

describe('reports', () => {
  it('summary: exact revenue by method and day, done work, visits, new patients, per dentist', async () => {
    await h.call('acctA', 'POST', `/v1/patients/${p1}/payments`, { method: 'cash', amount: '0.10' }); await h.call('acctA', 'POST', `/v1/patients/${p1}/payments`, { method: 'card', amount: '0.20' })
    const v = (await h.json(await h.call('acctA', 'POST', `/v1/patients/${p1}/payments`, { method: 'cash', amount: '999' }))).id; await h.call('acctA', 'POST', `/v1/payments/${v}/void`, { reason: 'typo' })
    const ids: string[] = []; for (const [i, hh] of [9, 10, 11].entries()) ids.push((await h.json(await h.call('recA', 'POST', '/v1/appointments', { patientId: p1, dentistId: dent, chairId: chair, startAt: iso(hh), endAt: iso(hh, ) .replace(':00:00', ':30:00') }))).id)
    for (const [id, st] of [[ids[0], 'completed'], [ids[1], 'no-show'], [ids[2], 'cancelled']]) await h.db.run('UPDATE appointment SET status=$1 WHERE id=$2', [st, id])
    const it1 = (await h.json(await h.call('dentA', 'POST', `/v1/patients/${p1}/plan`, { tooth: '11', procedure: 'filling', price: '300.50' }))).id; await h.call('dentA', 'PATCH', `/v1/plan/${it1}`, { status: 'done' })
    const r = await h.json(await h.call('acctA', 'GET', '/v1/reports/summary?from=2026-11-01&to=2026-11-30'))
    expect(r.revenue).toBeCloseTo(0.3, 10); expect(r.byMethod).toMatchObject({ cash: 0.1, card: 0.2, transfer: 0 }); expect(r.charged).toBe(300.5)
    expect([r.completed, r.noShows, r.cancelled, r.noShowRate]).toEqual([1, 1, 1, 0.5]); expect(r.newPatients).toBe(2); expect(r.byDentist).toEqual([{ dentistId: dent, name: 'Dr R', completed: 1 }])
    expect(r.bucket).toBe('day'); expect(r.series).toEqual([{ at: '2026-11-16', amount: 0.3 }])
    expect((await h.json(await h.call('acctA', 'GET', '/v1/reports/summary?from=2026-01-01&to=2026-12-31'))).bucket).toBe('month')
    expect((await h.json(await h.call('acctA', 'GET', '/v1/reports/summary?from=2026-12-01&to=2026-12-31'))).revenue).toBe(0)
  })
  it('summary: validation, permission and isolation', async () => {
    for (const q of ['', '?from=2026-11-01', '?from=2026-11-30&to=2026-11-01', '?from=2024-01-01&to=2026-11-30', '?from=2026-02-30&to=2026-03-01']) expect((await h.call('acctA', 'GET', `/v1/reports/summary${q}`)).status).toBe(400)
    expect((await h.call('recA', 'GET', '/v1/reports/summary?from=2026-11-01&to=2026-11-30')).status).toBe(403)
    expect((await h.json(await h.call('ownerB', 'GET', '/v1/reports/summary?from=2026-11-01&to=2026-11-30'))).revenue).toBe(0)
  })
  it('receivables and overdue: exact, biggest first, bounded', async () => {
    const crown = (await h.json(await h.call('acctA', 'POST', `/v1/patients/${p2}/invoices`, { lines: [{ label: 'Crown', price: '500.00' }], dueOn: '2026-10-01' }))).id
    await h.call('acctA', 'POST', `/v1/patients/${p1}/invoices`, { lines: [{ label: 'Clean', price: '100.00' }], dueOn: '2027-01-01' })
    const r = await h.json(await h.call('acctA', 'GET', '/v1/reports/receivables?top=1')); expect(r.owing).toBe(2); expect(r.total).toBeCloseTo(599.7, 5); expect(r.top).toEqual([{ patientId: p2, number: expect.any(String), fullName: 'Ana Pérez', due: 500 }])
    const o = await h.json(await h.call('acctA', 'GET', '/v1/reports/overdue')); expect(o.count).toBe(1); expect(o.top[0].remaining).toBe(500); expect(o.top[0].dueOn).toBe('2026-10-01')
    await h.call('acctA', 'POST', `/v1/patients/${p2}/payments`, { method: 'cash', amount: '500.00', invoiceId: crown })
    expect((await h.json(await h.call('acctA', 'GET', '/v1/reports/overdue'))).count).toBe(0)
    expect((await h.call('acctA', 'GET', '/v1/reports/receivables?top=500')).status).toBe(400)
    expect((await h.json(await h.call('ownerB', 'GET', '/v1/reports/receivables'))).owing).toBe(0)
  })
})

describe('duplicates and merge', () => {
  let dup: string
  it('finds duplicates by phone digits or a very similar name', async () => {
    dup = await mk('recA', '/v1/patients', { fullName: 'Karim Alaoui', phone: '+212 6 12 34 56 78', birthDate: '1985-03-02' })
    const byName = await h.json(await h.call('recA', 'POST', '/v1/patients/duplicate-check', { fullName: 'Karim Alaoui', birthDate: '1985-03-02' })); expect(byName.items.map((x: any) => x.id).sort()).toEqual([p1, dup].sort())
    const byPhone = await h.json(await h.call('recA', 'POST', '/v1/patients/duplicate-check', { fullName: 'Someone Else', phone: '0612 345 678' })); expect(byPhone.items.map((x: any) => x.id)).toEqual([p1]); expect(byPhone.items[0].reason).toBe('phone')
    expect((await h.json(await h.call('recA', 'POST', '/v1/patients/duplicate-check', { fullName: 'Karim Alaoui', birthDate: '1999-01-01' }))).items).toEqual([])
    expect((await h.json(await h.call('recA', 'GET', `/v1/patients/${dup}/duplicates`))).items.map((x: any) => x.id)).toEqual([p1])
    expect((await h.call('recA', 'POST', '/v1/patients/duplicate-check', { fullName: '' })).status).toBe(400)
    expect((await h.json(await h.call('recB', 'POST', '/v1/patients/duplicate-check', { fullName: 'Karim Alaoui' }))).items).toEqual([])
  })
  it('merge refuses a file with immutable records, naming them, and changes nothing', async () => {
    const r = await h.call('ownerA', 'POST', `/v1/patients/${p1}/merge`, { intoId: dup }); expect(r.status).toBe(409); const e = (await h.json(r)).error
    expect(e.code).toBe('merge_blocked'); expect(e.message).toMatch(/payments/); expect(e.message).toMatch(/completedTreatments/)
    expect((await h.json(await h.call('ownerA', 'GET', `/v1/patients/${p1}`))).archivedAt).toBeFalsy()
  })
  it('merge moves appointments, planned work, insurance, messages; fills blanks; archives the duplicate; audits', async () => {
    const a = await mk('recA', '/v1/appointments', { patientId: dup, dentistId: dent, chairId: chair, startAt: iso(14), endAt: iso(14).replace(':00:00', ':30:00') })
    await h.call('dentA', 'POST', `/v1/patients/${dup}/plan`, { procedure: 'cleaning', price: '50' })
    await h.call('recA', 'POST', `/v1/patients/${dup}/insurances`, { providerId: 'cnss', providerName: 'CNSS', number: '1' })
    await h.call('recA', 'PATCH', `/v1/patients/${dup}`, { email: 'k@x.test', notes: 'dup note' })
    expect((await h.call('recA', 'POST', `/v1/patients/${dup}/merge`, { intoId: p1 })).status).toBe(403) // needs patients.manage
    expect((await h.call('ownerA', 'POST', `/v1/patients/${dup}/merge`, { intoId: dup })).status).toBe(400)
    expect((await h.call('ownerB', 'POST', `/v1/patients/${dup}/merge`, { intoId: p1 })).status).toBe(404)
    expect((await h.call('ownerA', 'POST', `/v1/patients/${dup}/merge`, { intoId: p1 })).status).toBe(204)
    const k = await h.json(await h.call('ownerA', 'GET', `/v1/patients/${p1}`)); expect(k.email).toBe('k@x.test'); expect(k.notes).toMatch(/dup note/); expect(k.notes).toMatch(/Merged from/)
    expect((await h.db.rows<{ patient_id: string }>('SELECT patient_id FROM appointment WHERE id=$1', [a]))[0].patient_id).toBe(p1)
    expect((await h.json(await h.call('ownerA', 'GET', `/v1/patients/${p1}/insurances`))).items.length).toBe(1)
    const [d] = await h.db.rows<{ archived_at: string | null; merged_into_id: string }>('SELECT archived_at, merged_into_id FROM patient WHERE id=$1', [dup]); expect(d.archived_at).toBeTruthy(); expect(d.merged_into_id).toBe(p1)
    expect((await h.db.rows("SELECT 1 FROM audit_event WHERE action='patient.merged'")).length).toBe(1)
    expect((await h.call('ownerA', 'POST', `/v1/patients/${dup}/merge`, { intoId: p1 })).status).toBe(409) // already archived
  })
  it('overlapping appointments block a merge and roll everything back', async () => {
    const a = await mk('recA', '/v1/patients', { fullName: 'Over One' }), b = await mk('recA', '/v1/patients', { fullName: 'Over Two' })
    const c2 = await mk('ownerA', '/v1/chairs', { name: 'C2' }), d2 = await mk('ownerA', '/v1/dentists', { name: 'Dr S' })
    await mk('recA', '/v1/appointments', { patientId: a, dentistId: dent, chairId: chair, startAt: iso(16), endAt: iso(16).replace(':00:00', ':30:00') })
    await mk('recA', '/v1/appointments', { patientId: b, dentistId: d2, chairId: c2, startAt: iso(16), endAt: iso(16).replace(':00:00', ':30:00') })
    const r = await h.call('ownerA', 'POST', `/v1/patients/${b}/merge`, { intoId: a }); expect(r.status).toBe(409); expect((await h.json(r)).error.code).toBe('merge_blocked')
    expect((await h.db.rows<{ archived_at: string | null }>('SELECT archived_at FROM patient WHERE id=$1', [b]))[0].archived_at).toBeNull()
  })
})
