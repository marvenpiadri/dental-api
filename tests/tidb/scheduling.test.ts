// Real-cluster tests T4, T5, T6, T9, T10 (docs/architecture.md §5). Runs only when TIDB_TEST_URL points at a SCRATCH database; never production.
// T8 (multi-row INSERT atomicity) and T7 live in slots.test.ts. Lines starting "T4:" etc. are printed so the observed behaviour can go into the docs.
import { readFileSync, readdirSync } from 'node:fs'
import { connect } from '@tidbcloud/serverless'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDb, type Db } from '../../src/db/client'
import { createAppointment, rescheduleAppointment, sweepStale, SlotConflictError } from '../../src/appointments/slots'

const url = process.env.TIDB_TEST_URL
const num = (v: unknown) => Number(v)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!url)('TiDB: write conflicts, counters, version checks, reschedule, orphan sweep', () => {
  const db: Db = url ? getDb({ TIDB_DATABASE_URL: url }) : (undefined as never)
  const probe = `sched_probe_${Date.now()}`
  const value = async (id: number) => num((await db.rows<{ v: unknown }>(`SELECT v FROM ${probe} WHERE id = ?`, [id]))[0].v)
  const min = 60_000

  beforeAll(async () => {
    for (const f of readdirSync('db/migrations').sort())
      for (const s of readFileSync(`db/migrations/${f}`, 'utf8').replace(/--.*$/gm, '').split(/;\s*(?:\n|$)/).map((x) => x.trim()).filter(Boolean)) await db.run(s)
    await db.run(`CREATE TABLE ${probe} (id INT NOT NULL PRIMARY KEY, v INT NOT NULL, version INT NOT NULL DEFAULT 1)`)
    await db.run(`INSERT INTO ${probe} (id, v) VALUES (1, 0), (2, 0), (3, 0)`)
  })
  afterAll(async () => { if (url) await db.run(`DROP TABLE IF EXISTS ${probe}`) })

  it('T4: two interleaved transactions on one row → no lost update (one waits or one fails retryably)', async () => {
    const c = () => connect({ url: url ?? '', fullResult: true })
    const t1 = await c().begin(), t2 = await c().begin()
    await t1.execute(`UPDATE ${probe} SET v = v + 1 WHERE id = 1`)
    const second = t2.execute(`UPDATE ${probe} SET v = v + 1 WHERE id = 1`).then(() => 'ok' as const, (e: Error) => `error: ${e.message.slice(0, 100)}`)
    await sleep(700)
    await t1.commit()
    const s2 = await second
    let committed2 = false
    if (s2 === 'ok') committed2 = await t2.commit().then(() => true, (e: Error) => { console.log('T4: t2 commit rejected:', e.message.slice(0, 100)); return false })
    else await t2.rollback().catch(() => undefined)
    console.log(`T4: t2 update → ${s2}; t2 committed = ${committed2}`)
    expect(await value(1)).toBe(1 + (committed2 ? 1 : 0)) // every committed increment is present, none is lost
  })

  it('T5: 50 parallel counter increments (stateless) end at exactly 50', async () => {
    await Promise.all(Array.from({ length: 50 }, () => db.run(`UPDATE ${probe} SET v = v + 1 WHERE id = 2`)))
    expect(await value(2)).toBe(50)
  })

  it('T5b: 50 parallel increments in transactions: the final value equals the number of commits that succeeded', async () => {
    let committed = 0
    await Promise.all(Array.from({ length: 50 }, async () => {
      const tx = await connect({ url: url ?? '', fullResult: true }).begin()
      try { await tx.execute(`UPDATE ${probe} SET v = v + 1 WHERE id = 3`); await tx.commit(); committed++ } catch { await tx.rollback().catch(() => undefined) }
    }))
    console.log(`T5b: ${committed}/50 transactional increments committed`)
    expect(await value(3)).toBe(committed)
  })

  it('T6: 20 parallel version-checked updates → exactly one wins', async () => {
    const won = await Promise.all(Array.from({ length: 20 }, () => db.run(`UPDATE ${probe} SET version = version + 1 WHERE id = 1 AND version = 1`)))
    expect(won.reduce((a, b) => a + b, 0)).toBe(1)
  })

  it('T9: an appointment can move into its own old range; a stranger cannot take the range it now holds', async () => {
    const clinic = `t9-${crypto.randomUUID()}`, T = Date.parse('2026-12-02T09:00:00Z')
    const mine = { clinicId: clinic, dentistId: 'D', chairId: 'C', patientId: 'P' }
    const id = await createAppointment(db, { ...mine, startAt: T, endAt: T + 30 * min }, Date.now())
    await rescheduleAppointment(db, clinic, id, 1, { startAt: T + 15 * min, endAt: T + 45 * min }, Date.now()) // overlaps its own old range
    const [n] = await db.rows<{ n: unknown }>("SELECT COUNT(*) AS n FROM appointment_slot WHERE clinic_id = ? AND appointment_id = ?", [clinic, id])
    expect(num(n.n)).toBe(18) // 6 slots each for dentist, chair and patient
    await expect(createAppointment(db, { clinicId: clinic, dentistId: 'D', chairId: 'C2', patientId: 'P2', startAt: T + 30 * min, endAt: T + 60 * min }, Date.now())).rejects.toBeInstanceOf(SlotConflictError)
    const other = await createAppointment(db, { clinicId: clinic, dentistId: 'D', chairId: 'C3', patientId: 'P3', startAt: T + 60 * min, endAt: T + 90 * min }, Date.now())
    await expect(rescheduleAppointment(db, clinic, other, 1, { startAt: T + 20 * min, endAt: T + 50 * min }, Date.now())).rejects.toBeInstanceOf(SlotConflictError)
  })

  it('T10: a booking that fails after claiming leaves an orphan that blocks the slot until the sweep; no double booking meanwhile', async () => {
    const clinic = `t10-${crypto.randomUUID()}`, T = Date.parse('2026-12-03T09:00:00Z'), now = Date.now()
    // A database that dies right after the claims: it refuses the activation and the clean-up, like a Worker killed mid-request.
    const dying: Db = { rows: db.rows, run: (sql, p) => (/^(UPDATE appointment SET live|DELETE)/.test(sql) ? Promise.reject(new Error('simulated crash')) : db.run(sql, p)) }
    const who = { clinicId: clinic, dentistId: 'D', chairId: 'C', patientId: 'P' }
    await expect(createAppointment(dying, { ...who, startAt: T, endAt: T + 30 * min }, now)).rejects.toThrow('simulated crash')
    const slots = async () => num((await db.rows<{ n: unknown }>('SELECT COUNT(*) AS n FROM appointment_slot WHERE clinic_id = ?', [clinic]))[0].n)
    expect(await slots()).toBe(18) // the orphan's claims are still there
    await expect(createAppointment(db, { ...who, patientId: 'P2', chairId: 'C2', startAt: T, endAt: T + 30 * min }, Date.now())).rejects.toBeInstanceOf(SlotConflictError)
    await sweepStale(db, now + 10 * min) // past the 5-minute lease
    expect(await slots()).toBe(0)
    expect(num((await db.rows<{ n: unknown }>('SELECT COUNT(*) AS n FROM appointment WHERE clinic_id = ?', [clinic]))[0].n)).toBe(0)
    await createAppointment(db, { ...who, startAt: T, endAt: T + 30 * min }, Date.now()) // the slot is bookable again
  })
})
