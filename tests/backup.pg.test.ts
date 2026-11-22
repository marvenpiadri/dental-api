// Backup and restore, proven with the real pg_dump/pg_restore: populate through the API, back up, restore into a new database, compare everything.
// Needs a pg_dump at least as new as the server; otherwise the test is skipped (and says so) rather than passing on nothing.
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { harness } from './pg/harness'

const major = (s: string) => Number(/(\d+)\./.exec(s)?.[1] ?? 0)
const dumpMajor = major(spawnSync('pg_dump', ['--version'], { encoding: 'utf8' }).stdout ?? '')
let h: Awaited<ReturnType<typeof harness>>, serverMajor = 0
beforeAll(async () => { h = await harness(); serverMajor = major((await h.db.rows<{ v: string }>('SELECT current_setting(\'server_version\') AS v', []))[0].v) })
afterAll(async () => { await h.drop() })

describe('backup and restore', () => {
  it('a restored copy is identical to the source (rows, indexes, constraints, triggers)', async (ctx) => {
    if (!dumpMajor || dumpMajor < serverMajor) return ctx.skip()
    const p = (await h.json(await h.call('recA', 'POST', '/v1/patients', { fullName: 'Backup Patient' }))).id
    await h.call('dentA', 'POST', `/v1/patients/${p}/chart`, { chart: { version: '2.22', teeth: { '11': { status: 'present' } } } })
    await h.call('acctA', 'POST', `/v1/patients/${p}/invoices`, { lines: [{ label: 'Crown', price: '500.00' }] })
    await h.call('acctA', 'POST', `/v1/patients/${p}/payments`, { method: 'cash', amount: '120.50' })
    await h.call('dentA', 'POST', `/v1/patients/${p}/visits`, { complaint: 'Pain ünïcode ✓' })
    const dentist = (await h.json(await h.call('ownerA', 'POST', '/v1/dentists', { name: 'Dr R' }))).id
    const rx = (await h.json(await h.call('dentA', 'POST', `/v1/patients/${p}/prescriptions`, { dentistId: dentist, items: [{ name: 'Amoxicillin', strength: '500 mg' }] }))).id
    await h.call('dentA', 'POST', `/v1/prescriptions/${rx}/issue`, { expectedVersion: 1, acknowledged: [] })
    const r = spawnSync(process.execPath, ['tools/verify-backup.ts', h.url, process.env.TEST_DATABASE_URL!], { encoding: 'utf8' })
    expect(r.stderr).toBe(''); expect(r.stdout).toMatch(/RESTORE CHECK OK: \d+ tables, [1-9]\d* rows/); expect(r.status).toBe(0)
  })
})
