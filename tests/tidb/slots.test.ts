// Runs only when TIDB_TEST_URL is set (a scratch database). Until it has passed on a real cluster, nothing in docs §13 "needs a real TiDB test" is verified.
import { readFileSync, readdirSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { getDb, DuplicateKeyError } from '../../src/db/client'
import { createAppointment, SlotConflictError } from '../../src/appointments/slots'

const url = process.env.TIDB_TEST_URL
describe.skipIf(!url)('TiDB: driver behaviour and slot claims', () => {
  const db = url ? getDb({ TIDB_DATABASE_URL: url }) : (undefined as never)
  const clinic = `t-${crypto.randomUUID()}`
  const T = Date.parse('2026-12-01T09:00:00Z')

  beforeAll(async () => {
    for (const f of readdirSync('db/migrations').sort())
      for (const s of readFileSync(`db/migrations/${f}`, 'utf8').replace(/--.*$/gm, '').split(/;\s*(?:\n|$)/).map((x) => x.trim()).filter(Boolean)) await db.run(s)
  })

  it('T0 reports server facts we depend on', async () => {
    const [r] = await db.rows<{ v: string; m: string }>('SELECT VERSION() AS v, @@sql_mode AS m')
    console.log('TiDB', r.v, 'sql_mode =', r.m)
    expect(r.m).not.toMatch(/NO_BACKSLASH_ESCAPES/) // the driver escapes client-side assuming backslash escapes
  })
  it('maps duplicate keys to DuplicateKeyError', async () => {
    const k = `dup-${crypto.randomUUID()}`
    await db.run('INSERT INTO clinic (id, name, created_at) VALUES (?, ?, ?)', [k, 'x', '2026-01-01 00:00:00.000'])
    await expect(db.run('INSERT INTO clinic (id, name, created_at) VALUES (?, ?, ?)', [k, 'x', '2026-01-01 00:00:00.000'])).rejects.toBeInstanceOf(DuplicateKeyError)
  })
  it('a multi-row INSERT that hits a duplicate inserts none of its rows (statement atomicity)', async () => {
    const a = `a-${crypto.randomUUID()}`
    const row = (s: string) => [clinic, 'dentist', a, s, 'x', '2026-01-01 00:00:00.000']
    await db.run('INSERT INTO appointment_slot VALUES (?, ?, ?, ?, ?, ?)', row('2026-12-01 10:05:00.000'))
    await expect(db.run('INSERT INTO appointment_slot VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)', [...row('2026-12-01 10:00:00.000'), ...row('2026-12-01 10:05:00.000')])).rejects.toBeInstanceOf(DuplicateKeyError)
    const [n] = await db.rows<{ n: unknown }>('SELECT COUNT(*) AS n FROM appointment_slot WHERE clinic_id = ? AND resource_id = ?', [clinic, a])
    expect(Number(n.n)).toBe(1)
  })
  it('T7: 20 concurrent bookings of the same slot -> exactly one wins, no stray claims', async () => {
    const who = (i: number) => ({ clinicId: clinic, dentistId: 'D', chairId: `C${i}`, patientId: `P${i}` }) // contend on the dentist only
    const res = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => createAppointment(db, { ...who(i), startAt: T, endAt: T + 30 * 60_000 }, Date.now())))
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    for (const r of res) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(SlotConflictError)
    const [n] = await db.rows<{ n: unknown }>("SELECT COUNT(*) AS n FROM appointment_slot WHERE clinic_id = ? AND resource_kind = 'dentist' AND resource_id = 'D'", [clinic])
    expect(Number(n.n)).toBe(6)
    const [c] = await db.rows<{ n: unknown }>('SELECT COUNT(*) AS n FROM appointment WHERE clinic_id = ?', [clinic])
    expect(Number(c.n)).toBe(1) // losers' rows were removed
  })
  it('DECIMAL stays a string and DATETIME(3) round-trips', async () => {
    const [r] = await db.rows<{ d: unknown; t: unknown }>("SELECT CAST('0.10' AS DECIMAL(12,2)) AS d, CAST('2026-12-01 09:00:00.123' AS DATETIME(3)) AS t")
    expect(r.d).toBe('0.10'); expect(r.t).toBe('2026-12-01 09:00:00.123')
  })
})
