// Applies db/migrations/*.sql in order, once each, recording them in schema_migration. Additive only; never run against production without approval.
// Usage: node --env-file=.dev.vars tools/migrate.ts [--check]   (--check lists pending files and needs no database)
import { readdirSync, readFileSync } from 'node:fs'
import { getDb } from '../src/db/client.ts'

const files = readdirSync('db/migrations').filter((f) => f.endsWith('.sql')).sort()
if (process.argv.includes('--check')) { console.log(files.join('\n')); process.exit(0) }
const db = getDb({ TIDB_DATABASE_URL: process.env.TIDB_DATABASE_URL ?? '' })
await db.run('CREATE TABLE IF NOT EXISTS schema_migration (name VARCHAR(100) NOT NULL PRIMARY KEY, applied_at DATETIME(3) NOT NULL)')
const done = new Set((await db.rows<{ name: string }>('SELECT name FROM schema_migration')).map((r) => r.name))
for (const f of files.filter((x) => !done.has(x))) {
  for (const stmt of readFileSync(`db/migrations/${f}`, 'utf8').replace(/--.*$/gm, '').split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean)) await db.run(stmt)
  await db.run('INSERT INTO schema_migration (name, applied_at) VALUES (?, ?)', [f, new Date().toISOString().replace('T', ' ').replace('Z', '')])
  console.log('applied', f)
}
