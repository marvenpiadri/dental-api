// Real PostgreSQL: migration runner, constraints, tenant isolation by foreign keys, append-only trigger, transactions.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { writeFileSync, mkdtempSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate } from '../tools/migrate-lib'
import { DuplicateKeyError, type PgDb } from '../src/db/client'
import { createClinic } from '../src/admin/bootstrap'
import { testDb } from './pg/db'

let db: PgDb, url: string, drop: () => Promise<void>
beforeAll(async () => { ({ db, url, drop } = await testDb()) })
afterAll(async () => { await drop() })
const N = Date.parse('2026-11-20T10:00:00Z')
const mk = (name: string) => createClinic(db, 'pepper', { clinicName: name, ownerEmail: `${name}@x.test`, ownerName: name, password: 'correct horse battery' }, N)

describe('migrations', () => {
  it('are idempotent and record checksums; a changed applied file is refused', async () => {
    expect(await migrate(url)).toEqual([])
    const dir = mkdtempSync(join(tmpdir(), 'mig-')); copyFileSync('db/migrations/0001_identity.sql', join(dir, '0001_identity.sql'))
    writeFileSync(join(dir, '0001_identity.sql'), '-- edited\n' + (await import('node:fs')).readFileSync('db/migrations/0001_identity.sql', 'utf8'))
    await expect(migrate(url, dir)).rejects.toThrow(/changed after it was applied/)
  })
  it('a failing migration rolls back completely', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-')); writeFileSync(join(dir, '9999_bad.sql'), 'CREATE TABLE half_done (id int); SELECT 1/0;')
    await expect(migrate(url, dir)).rejects.toThrow(/failed/)
    expect((await db.rows("SELECT to_regclass('half_done') AS t"))[0].t).toBeNull()
  })
})

describe('schema integrity', () => {
  it('rejects a duplicate staff e-mail with DuplicateKeyError', async () => {
    await mk('dup'); await expect(mk('dup')).rejects.toThrow('email already in use')
    await expect(db.run('INSERT INTO clinic (id,name,created_at) VALUES ($1,$2,now())', [crypto.randomUUID(), ' '])).rejects.toThrow() // CHECK on name
  })
  it('composite foreign keys stop a session or permission from crossing clinics', async () => {
    const a = await mk('a1'), b = await mk('b1')
    await expect(db.run('INSERT INTO auth_session (token_hash, clinic_id, staff_id, created_at, last_seen_at, expires_at) VALUES ($1,$2,$3,now(),now(),now())', ['a'.repeat(64), b.clinicId, a.staffId])).rejects.toThrow(/foreign key/)
    await expect(db.run("INSERT INTO staff_permission (clinic_id, staff_id, permission, kind) VALUES ($1,$2,'patients.view','extra')", [b.clinicId, a.staffId])).rejects.toThrow(/foreign key/)
  })
  it('audit_event is append-only (UPDATE and DELETE are refused by the database)', async () => {
    const a = await mk('au')
    await expect(db.run("UPDATE audit_event SET action = 'x' WHERE clinic_id = $1", [a.clinicId])).rejects.toThrow(/append-only/)
    await expect(db.run('DELETE FROM audit_event WHERE clinic_id = $1', [a.clinicId])).rejects.toThrow(/append-only/)
  })
  it('transactions roll back everything on error, and the unique error maps to DuplicateKeyError', async () => {
    const c = crypto.randomUUID()
    await expect(db.tx(async (q) => { await q.run('INSERT INTO clinic (id,name,created_at) VALUES ($1,$2,now())', [c, 'tx']); throw new Error('boom') })).rejects.toThrow('boom')
    expect(await db.rows('SELECT id FROM clinic WHERE id = $1', [c])).toHaveLength(0)
    const s = await mk('uq')
    await expect(db.run("INSERT INTO staff (id,clinic_id,email_norm,name,role,password_hash,created_at) VALUES ($1,$2,'uq@x.test','n','owner','h',now())", [crypto.randomUUID(), s.clinicId])).rejects.toBeInstanceOf(DuplicateKeyError)
  })
  it('returns timestamptz as ISO strings and keeps numeric exact', async () => {
    const [r] = await db.rows<{ t: string; n: string; d: string }>("SELECT '2026-11-20T10:00:00Z'::timestamptz AS t, 0.10::numeric(12,2) + 0.20 AS n, '2026-11-20'::date AS d")
    expect(r).toEqual({ t: '2026-11-20T10:00:00.000Z', n: '0.30', d: '2026-11-20' })
  })
  it('runs 40 parallel statements through the pool without exhausting connections', async () => {
    const out = await Promise.all(Array.from({ length: 40 }, (_, i) => db.rows<{ i: number }>('SELECT $1::int AS i', [i])))
    expect(out.map((r) => r[0].i)).toEqual(Array.from({ length: 40 }, (_, i) => i))
  })
})
