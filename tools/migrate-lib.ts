// Forward-only SQL migrations. Each file runs in its own transaction and is recorded with its SHA-256; an applied file that
// changed on disk is refused. Node only (never bundled into the Worker). Needs the OWNER role and a direct (non-pooled) connection.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import pg from 'pg'

export async function migrate(connectionString: string, dir = 'db/migrations', log: (s: string) => void = () => undefined): Promise<string[]> {
  const client = new pg.Client({ connectionString })
  await client.connect()
  const applied: string[] = []
  try {
    await client.query('SELECT pg_advisory_lock(727001)') // two deployers must not migrate at once
    await client.query('CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())')
    const done = new Map((await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migration')).rows.map((r) => [r.name, r.checksum]))
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      const sql = readFileSync(`${dir}/${f}`, 'utf8'), sum = createHash('sha256').update(sql).digest('hex')
      if (done.has(f)) { if (done.get(f) !== sum) throw new Error(`migration ${f} changed after it was applied`); continue }
      try {
        await client.query('BEGIN'); await client.query(sql)
        await client.query('INSERT INTO schema_migration (name, checksum) VALUES ($1, $2)', [f, sum]); await client.query('COMMIT')
      } catch (e) { await client.query('ROLLBACK').catch(() => undefined); throw new Error(`migration ${f} failed: ${(e as Error).message}`) }
      applied.push(f); log(`applied ${f}`)
    }
  } finally { await client.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined); await client.end() }
  return applied
}
