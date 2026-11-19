// Real-cluster tests T1, T2, T11–T15 (docs/architecture.md §5). Runs only when TIDB_TEST_URL points at a SCRATCH database; never production.
// These characterise the driver and cluster: where a test only logs ("T13", parts of T12/T14), read the printed line and record it in the docs.
import { readFileSync, readdirSync } from 'node:fs'
import { connect } from '@tidbcloud/serverless'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDb, MAX_ROWS, type Db } from '../../src/db/client'
import { BillingError, issueInvoice } from '../../src/billing/service'

const url = process.env.TIDB_TEST_URL
const raw = (fetchImpl?: typeof fetch) => connect({ url: url ?? '', fullResult: true, ...(fetchImpl && { fetch: fetchImpl }) })
const num = (v: unknown) => Number(v)

describe.skipIf(!url)('TiDB: transactions, numbering, isolation, result cap', () => {
  const db: Db = url ? getDb({ TIDB_DATABASE_URL: url }) : (undefined as never)
  const clinic = `t-${crypto.randomUUID()}`
  const probe = `probe_${Date.now()}`

  beforeAll(async () => {
    for (const f of readdirSync('db/migrations').sort())
      for (const s of readFileSync(`db/migrations/${f}`, 'utf8').replace(/--.*$/gm, '').split(/;\s*(?:\n|$)/).map((x) => x.trim()).filter(Boolean)) await db.run(s)
    await db.run(`CREATE TABLE ${probe} (id INT NOT NULL PRIMARY KEY, v INT NOT NULL)`)
    await db.run(`INSERT INTO ${probe} VALUES (1, 0), (2, 0)`)
  })
  afterAll(async () => { if (url) await db.run(`DROP TABLE IF EXISTS ${probe}`) })

  it('T1: a stateless write is durable and visible to the next call', async () => {
    await db.run(`UPDATE ${probe} SET v = 5 WHERE id = 2`)
    expect(num((await db.rows<{ v: unknown }>(`SELECT v FROM ${probe} WHERE id = 2`))[0].v)).toBe(5)
    await db.run(`UPDATE ${probe} SET v = 0 WHERE id = 2`)
  })

  it('T2: begin → write → commit is invisible to others until commit', async () => {
    const tx = await raw().begin()
    await tx.execute(`UPDATE ${probe} SET v = 7 WHERE id = 1`)
    expect(num((await db.rows<{ v: unknown }>(`SELECT v FROM ${probe} WHERE id = 1`))[0].v)).toBe(0)
    await tx.commit()
    expect(num((await db.rows<{ v: unknown }>(`SELECT v FROM ${probe} WHERE id = 1`))[0].v)).toBe(7)
    await db.run(`UPDATE ${probe} SET v = 0 WHERE id = 1`)
  })

  it('T2b: rollback discards the write', async () => {
    const tx = await raw().begin()
    await tx.execute(`UPDATE ${probe} SET v = 9 WHERE id = 1`)
    await tx.rollback()
    expect(num((await db.rows<{ v: unknown }>(`SELECT v FROM ${probe} WHERE id = 1`))[0].v)).toBe(0)
  })

  it('T11: 20 parallel invoice issues → no duplicate numbers; the only failure allowed is a typed number_conflict; numbers contiguous from 1', async () => {
    const patient = `P-${crypto.randomUUID()}`
    const now = Date.parse('2026-11-19T10:00:00Z')
    const res = await Promise.allSettled(Array.from({ length: 20 }, () => issueInvoice(db, { clinicId: clinic, patientId: patient, lines: [{ label: 'Filling', price: '100.00' }], now, tz: 'Africa/Casablanca', currency: 'MAD', staffId: null })))
    const ok = res.flatMap((r) => (r.status === 'fulfilled' ? [r.value.number] : []))
    for (const r of res) if (r.status === 'rejected') { expect(r.reason).toBeInstanceOf(BillingError); expect((r.reason as BillingError).code).toBe('number_conflict') }
    console.log(`T11: ${ok.length}/20 issued, ${20 - ok.length} reported number_conflict (retry budget is 6 attempts)`)
    expect(new Set(ok).size).toBe(ok.length)
    const live = await db.rows<{ seq: unknown }>('SELECT seq FROM invoice WHERE clinic_id = ? AND live = 1 ORDER BY seq', [clinic])
    expect(live.map((r) => num(r.seq))).toEqual(Array.from({ length: ok.length }, (_, i) => i + 1))
    expect(ok.length).toBeGreaterThan(0)
  })

  it('T12: a request aborted mid-transaction does not commit and releases its row lock; logs how long that took', async () => {
    const ac = new AbortController()
    const c = raw((i, init) => fetch(i, { ...init, signal: ac.signal }))
    const tx = await c.begin()
    await tx.execute(`UPDATE ${probe} SET v = 99 WHERE id = 2`) // takes the row lock
    ac.abort() // the client vanishes before commit
    await expect(tx.commit()).rejects.toBeDefined()
    const t0 = Date.now()
    await db.run(`UPDATE ${probe} SET v = v + 1 WHERE id = 2`) // blocks until the server drops the orphaned transaction
    const waited = Date.now() - t0
    console.log(`T12: row lock released after ${waited} ms`)
    expect(num((await db.rows<{ v: unknown }>(`SELECT v FROM ${probe} WHERE id = 2`))[0].v)).toBe(1) // 0 + 1, never 99
    expect(waited).toBeLessThan(55_000)
    await db.run(`UPDATE ${probe} SET v = 0 WHERE id = 2`)
  })

  it('T13: statements run in parallel inside ONE transaction (forbidden): records what happens so code never does it', async () => {
    const tx = await raw().begin()
    const out = await Promise.allSettled([tx.execute(`UPDATE ${probe} SET v = v + 1 WHERE id = 1`), tx.execute(`UPDATE ${probe} SET v = v + 1 WHERE id = 2`)])
    console.log('T13:', out.map((o) => (o.status === 'fulfilled' ? 'ok' : `rejected: ${String((o.reason as Error).message).slice(0, 120)}`)).join(' | '))
    await tx.rollback().catch(() => undefined)
    await db.run(`UPDATE ${probe} SET v = 0`)
    expect(out).toHaveLength(2)
  })

  it('T14: READ COMMITTED sees a concurrent commit mid-transaction; REPEATABLE READ does not', async () => {
    for (const [iso, sees] of [['READ COMMITTED', true], ['REPEATABLE READ', false]] as const) {
      await db.run(`UPDATE ${probe} SET v = 0 WHERE id = 1`)
      const tx = await raw().begin({ isolation: iso })
      const first = num(((await tx.execute(`SELECT v FROM ${probe} WHERE id = 1`)) as { rows: { v: unknown }[] }).rows[0].v)
      await db.run(`UPDATE ${probe} SET v = 1 WHERE id = 1`)
      const second = num(((await tx.execute(`SELECT v FROM ${probe} WHERE id = 1`)) as { rows: { v: unknown }[] }).rows[0].v)
      await tx.rollback()
      console.log(`T14 ${iso}: first read ${first}, second read ${second}`)
      expect(first).toBe(0)
      expect(second).toBe(sees ? 1 : 0)
    }
  })

  it('T15: a query returning more than 10,000 rows errors or truncates (our code never relies on either: pagination caps at 100)', async () => {
    const big = `big_${Date.now()}`
    await db.run(`CREATE TABLE ${big} (id INT NOT NULL PRIMARY KEY)`)
    try {
      for (let start = 1; start <= 10_500; start += 500) await db.run(`INSERT INTO ${big} VALUES ${Array.from({ length: Math.min(500, 10_501 - start) }, (_, i) => `(${start + i})`).join(', ')}`)
      const out = await db.rows(`SELECT id FROM ${big}`).then((r) => `returned ${r.length} rows`, (e: Error) => `error: ${e.message.slice(0, 120)}`)
      console.log(`T15: ${out} (MAX_ROWS = ${MAX_ROWS})`)
      expect(await db.rows(`SELECT id FROM ${big} ORDER BY id LIMIT 100`)).toHaveLength(100)
    } finally { await db.run(`DROP TABLE IF EXISTS ${big}`) }
  })
})
