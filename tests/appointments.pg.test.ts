// Real PostgreSQL: appointments API, EXCLUDE-constraint double-booking guard, concurrency, reschedule/status rules, isolation, pagination.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { harness } from './pg/harness'

let h: Awaited<ReturnType<typeof harness>>
let pA: string, pA2: string, pB: string, dA: string, dA2: string, dB: string, cA: string, cA2: string, cB: string
const iso = (hh: number, m = 0, day = 16) => new Date(Date.UTC(2026, 10, day, hh, m)).toISOString()
const appt = (o: object = {}) => ({ patientId: pA, dentistId: dA, chairId: cA, startAt: iso(9), endAt: iso(9, 30), ...o })
const book = (o: object = {}, who = 'recA') => h.call(who, 'POST', '/v1/appointments', appt(o))
const idOf = async (r: Response) => (await h.json(r)).id as string
const mk = async (who: string, path: string, o: object) => (await h.json(await h.call(who, 'POST', path, o))).id as string

beforeAll(async () => {
  h = await harness()
  pA = await mk('recA', '/v1/patients', { fullName: 'PA' }); pA2 = await mk('recA', '/v1/patients', { fullName: 'PA2' }); pB = await mk('recB', '/v1/patients', { fullName: 'PB' })
  dA = await mk('ownerA', '/v1/dentists', { name: 'Dr A' }); dA2 = await mk('ownerA', '/v1/dentists', { name: 'Dr A2' }); dB = await mk('ownerB', '/v1/dentists', { name: 'Dr B' })
  cA = await mk('ownerA', '/v1/chairs', { name: 'C1' }); cA2 = await mk('ownerA', '/v1/chairs', { name: 'C2' }); cB = await mk('ownerB', '/v1/chairs', { name: 'CB' })
})
afterAll(async () => { await h.drop() })

describe('resources (dentists, chairs)', () => {
  it('settings.edit manages them; appointments.view reads; validation; isolation; archived are hidden', async () => {
    expect((await h.call('recA', 'POST', '/v1/chairs', { name: 'x' })).status).toBe(403)
    expect((await h.call('ownerA', 'POST', '/v1/chairs', { name: 'x', color: 'red' })).status).toBe(400)
    const d = await mk('ownerA', '/v1/dentists', { name: 'Dr Z', specialty: 'Ortho', hours: { open: '09:00', close: '17:00' } })
    expect((await h.call('ownerA', 'POST', '/v1/dentists', { name: 'Dr bad', hours: { open: '25:00' } })).status).toBe(400)
    expect((await h.call('ownerA', 'PATCH', `/v1/dentists/${d}`, { phone: '0600' })).status).toBe(204)
    expect((await h.call('ownerB', 'PATCH', `/v1/dentists/${d}`, { phone: 'x' })).status).toBe(404)
    expect((await h.json(await h.call('recA', 'GET', '/v1/dentists'))).items.find((x: any) => x.id === d).hours).toEqual({ open: '09:00', close: '17:00' })
    expect((await h.call('ownerA', 'POST', `/v1/dentists/${d}/archive`)).status).toBe(204)
    expect((await h.json(await h.call('recA', 'GET', '/v1/dentists'))).items.map((x: any) => x.id)).not.toContain(d)
    expect((await h.json(await h.call('ownerB', 'GET', '/v1/dentists'))).items).toHaveLength(1)
  })
})

describe('booking', () => {
  it('requires a session and the right permission', async () => {
    expect((await h.app.request('/v1/appointments?from=a&to=b', {}, { PASSWORD_PEPPER: 'p', APP_ORIGIN: 'https://app.test', API_ORIGIN: 'https://api.test' })).status).toBe(401)
    expect((await book({}, 'acctA')).status).toBe(403)
  })
  it('books, and a conflicting booking is 409 slot_taken for dentist, chair and patient independently', async () => {
    expect((await book()).status).toBe(201)
    for (const o of [{ chairId: cA2, patientId: pA2 }, { dentistId: dA2, patientId: pA2 }, { dentistId: dA2, chairId: cA2 }]) {
      const r = await book({ ...o, startAt: iso(9, 15), endAt: iso(9, 45) }); expect(r.status).toBe(409); expect((await h.json(r)).error.code).toBe('slot_taken')
    }
    expect((await book({ dentistId: dA2, chairId: cA2, patientId: pA2, startAt: iso(9, 15), endAt: iso(9, 45) })).status).toBe(201) // nothing shared: fine
  })
  it('back-to-back is allowed; the same time in the other clinic never conflicts', async () => {
    expect((await book({ startAt: iso(9, 30), endAt: iso(10) })).status).toBe(201)
    expect((await book({ patientId: pB, dentistId: dB, chairId: cB }, 'recB')).status).toBe(201)
  })
  it('validates input: off-grid, duration, non-UTC, missing, bad ids', async () => {
    expect((await book({ startAt: iso(11, 3), endAt: iso(11, 33) })).status).toBe(422)
    expect((await book({ startAt: iso(11), endAt: iso(11, 10) })).status).toBe(422)
    expect((await book({ startAt: iso(11), endAt: iso(20) })).status).toBe(422)
    expect((await book({ startAt: '2026-11-16T11:00:00+01:00' })).status).toBe(400)
    expect((await h.call('recA', 'POST', '/v1/appointments', { patientId: pA })).status).toBe(400)
    expect((await book({ patientId: 'x' })).status).toBe(400)
    expect((await book({ status: 'completed', startAt: iso(12), endAt: iso(12, 30) })).status).toBe(422)
  })
  it("never lets one clinic reference or touch another clinic's rows", async () => {
    expect((await book({ patientId: pB })).status).toBe(404)
    expect((await book({ dentistId: dB, startAt: iso(13), endAt: iso(13, 30) })).status).toBe(404)
    const id = await idOf(await book({ patientId: pB, dentistId: dB, chairId: cB, startAt: iso(14), endAt: iso(14, 30) }, 'recB'))
    expect((await h.call('recA', 'POST', `/v1/appointments/${id}/status`, { status: 'cancelled' })).status).toBe(404)
    expect((await h.call('recA', 'POST', `/v1/appointments/${id}/reschedule`, { version: 1, startAt: iso(15), endAt: iso(15, 30) })).status).toBe(404)
    const list = await h.json(await h.call('recA', 'GET', `/v1/appointments?from=${iso(0)}&to=${iso(23)}`))
    expect(list.items.every((x: any) => x.patientId !== pB)).toBe(true)
    expect((await h.call('recA', 'GET', `/v1/appointments/${id}/history`)).status).toBe(404)
  })
  it('the database itself refuses an overlap that bypasses the API (EXCLUDE constraint)', async () => {
    await expect(h.db.run(`INSERT INTO appointment (id, clinic_id, patient_id, dentist_id, chair_id, start_at, end_at, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())`,
      [crypto.randomUUID(), h.A.clinicId, pA2, dA, cA2, iso(9, 10), iso(9, 40)])).rejects.toThrow()
  })
})

describe('concurrency', () => {
  it('20 simultaneous bookings of the same slot: exactly one wins, the rest get 409', async () => {
    const pts = await Promise.all(Array.from({ length: 20 }, (_, i) => mk('recA', '/v1/patients', { fullName: `Race ${i}` })))
    const rs = await Promise.all(pts.map((p) => book({ patientId: p, startAt: iso(15), endAt: iso(15, 30) })))
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1); expect(rs.filter((r) => r.status === 409)).toHaveLength(19)
    expect(Number((await h.db.rows<{ n: string }>('SELECT count(*) n FROM appointment WHERE dentist_id=$1 AND start_at=$2', [dA, iso(15)]))[0].n)).toBe(1)
  })
  it('overlapping-but-different ranges race: no two active appointments ever overlap for one dentist', async () => {
    const pts = await Promise.all(Array.from({ length: 12 }, (_, i) => mk('recA', '/v1/patients', { fullName: `Ov ${i}` })))
    await Promise.all(pts.map((p, i) => book({ patientId: p, chairId: cA2, dentistId: dA2, startAt: iso(16, i * 5), endAt: iso(16, i * 5 + 30) })))
    const rows = await h.db.rows<{ s: string; e: string }>('SELECT start_at s, end_at e FROM appointment WHERE dentist_id=$1 AND start_at >= $2 AND start_at < $3 ORDER BY start_at', [dA2, iso(16), iso(18)])
    for (let i = 1; i < rows.length; i++) expect(Date.parse(rows[i].s)).toBeGreaterThanOrEqual(Date.parse(rows[i - 1].e))
  })
  it('two simultaneous reschedules with the same version: one wins, the other is stale or taken', async () => {
    const id = await idOf(await book({ startAt: iso(19), endAt: iso(19, 30) }))
    const rs = await Promise.all([h.call('recA', 'POST', `/v1/appointments/${id}/reschedule`, { version: 1, startAt: iso(20), endAt: iso(20, 30) }), h.call('recA', 'POST', `/v1/appointments/${id}/reschedule`, { version: 1, startAt: iso(21), endAt: iso(21, 30) })])
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409])
  })
})

describe('reschedule and status', () => {
  it('reschedules with a version (own old range allowed), keeps history, rejects a stale version', async () => {
    const id = await idOf(await book({ startAt: iso(7), endAt: iso(7, 30) }))
    const moved = await h.call('recA', 'POST', `/v1/appointments/${id}/reschedule`, { version: 1, startAt: iso(7, 15), endAt: iso(7, 45) })
    expect(moved.status).toBe(200); expect(await h.json(moved)).toEqual({ version: 2 }) // the new revision comes back, so the browser need not re-read
    const stale = await h.call('recA', 'POST', `/v1/appointments/${id}/reschedule`, { version: 1, startAt: iso(8), endAt: iso(8, 30) })
    expect(stale.status).toBe(409); expect((await h.json(stale)).error.code).toBe('stale')
    const hist = await h.json(await h.call('recA', 'GET', `/v1/appointments/${id}/history`))
    expect(hist.schedule).toHaveLength(1); expect(hist.schedule[0].fromStart).toBe(iso(7)); expect(hist.status[0].to).toBe('scheduled')
  })
  it('a move into someone else’s time is refused and leaves the original booking intact', async () => {
    const id = await idOf(await book({ startAt: iso(5), endAt: iso(5, 30) }))
    expect((await h.call('recA', 'POST', `/v1/appointments/${id}/reschedule`, { version: 1, startAt: iso(9), endAt: iso(9, 30) })).status).toBe(409)
    const a = (await h.json(await h.call('recA', 'GET', `/v1/appointments?from=${iso(5)}&to=${iso(6)}`))).items.find((x: any) => x.id === id)
    expect(a.startAt).toBe(iso(5)); expect(a.version).toBe(1)
  })
  it('enforces transitions; cancel frees the time; reinstating fails if the time was taken', async () => {
    const id = await idOf(await book({ startAt: iso(3), endAt: iso(3, 30) }))
    const st = (s: string, who = 'recA') => h.call(who, 'POST', `/v1/appointments/${id}/status`, { status: s })
    expect((await st('completed')).status).toBe(422)
    expect((await st('cancelled')).status).toBe(200)
    expect((await book({ startAt: iso(3), endAt: iso(3, 30) })).status).toBe(201) // freed
    expect((await st('scheduled')).status).toBe(409) // taken meanwhile
    expect((await h.call('recA', 'POST', `/v1/appointments/${id}/reschedule`, { version: 2, startAt: iso(4), endAt: iso(4, 30) })).status).toBe(422) // cancelled cannot move
  })
  it('status history is append-only', async () => {
    await expect(h.db.run('UPDATE appointment_status_change SET reason = $1', ['x'])).rejects.toThrow(/append-only/)
  })
})

describe('calendar read', () => {
  it('requires a bounded range, paginates by keyset without gaps, caps the limit', async () => {
    const q = `from=${iso(0)}&to=${iso(23)}`, seen: string[] = []; let cursor = ''
    for (let i = 0; i < 40; i++) { const r = await h.json(await h.call('recA', 'GET', `/v1/appointments?${q}&limit=5${cursor ? `&cursor=${cursor}` : ''}`)); seen.push(...r.items.map((x: any) => x.id)); if (!r.nextCursor) break; cursor = r.nextCursor }
    const total = Number((await h.db.rows<{ n: string }>('SELECT count(*) n FROM appointment WHERE clinic_id=$1 AND start_at >= $2 AND start_at < $3', [h.A.clinicId, iso(0), iso(23)]))[0].n)
    expect(seen).toHaveLength(total); expect(new Set(seen).size).toBe(total)
    for (const bad of [`limit=101`, `limit=0`, 'cursor=%25%25']) expect((await h.call('recA', 'GET', `/v1/appointments?${q}&${bad}`)).status).toBe(400)
    expect((await h.call('recA', 'GET', '/v1/appointments?from=x&to=y')).status).toBe(400)
    expect((await h.call('recA', 'GET', `/v1/appointments?from=${iso(0)}&to=2027-06-01T00:00:00Z`)).status).toBe(400)
  })
})

describe('a patient\'s appointment list', () => {
  it('is newest first, keyset-paginated, bounded, and isolated per clinic', async () => {
    const p = await mk('recA', '/v1/patients', { fullName: 'History Hana' })
    for (let i = 0; i < 5; i++) expect((await book({ patientId: p, startAt: iso(8 + i, 0, 20), endAt: iso(8 + i, 30, 20) })).status).toBe(201)
    const first = await h.json(await h.call('recA', 'GET', `/v1/patients/${p}/appointments?limit=2`))
    expect(first.items).toHaveLength(2); expect(first.nextCursor).toBeTruthy()
    expect(first.items[0].startAt > first.items[1].startAt).toBe(true)
    const rest = await h.json(await h.call('recA', 'GET', `/v1/patients/${p}/appointments?limit=100&cursor=${encodeURIComponent(first.nextCursor)}`))
    expect(rest.items).toHaveLength(3); expect(rest.nextCursor).toBeNull()
    expect(new Set([...first.items, ...rest.items].map((x: { id: string }) => x.id)).size).toBe(5)
    expect((await h.call('recA', 'GET', `/v1/patients/${p}/appointments?limit=101`)).status).toBe(400)
    expect((await h.call('recA', 'GET', `/v1/patients/${p}/appointments?cursor=zzz`)).status).toBe(400)
    expect((await h.json(await h.call('recB', 'GET', `/v1/patients/${p}/appointments`))).items).toHaveLength(0)
    expect((await h.call('acctA', 'GET', `/v1/patients/${p}/appointments`)).status).toBe(403)
  })
})
