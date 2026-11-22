// Proves a backup can be restored: pg_dump the source, pg_restore into a brand-new database, then compare every table (row count + content hash),
// and the schema objects (indexes, constraints, triggers) and the migration ledger. Usage: node tools/verify-backup.ts <source-url> <admin-url>
//   <source-url>: the database to back up (read only). <admin-url>: a server where a scratch database may be created and dropped (can be the same server).
// pg_dump must be at least the server's major version (Neon: use the matching client). Exits non-zero on any difference.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'

const [src, admin] = process.argv.slice(2)
if (!src || !admin) { console.error('usage: node tools/verify-backup.ts <source-url> <admin-url>'); process.exit(2) }

async function fingerprint(url: string) {
  const c = new pg.Client({ connectionString: url }); await c.connect()
  try {
    const tables = (await c.query<{ t: string }>("SELECT table_name t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1")).rows.map((r) => r.t)
    const out: Record<string, string> = {}
    for (const t of tables) { const r = await c.query<{ n: string; h: string }>(`SELECT count(*)::text n, COALESCE(md5(string_agg(x::text, '|' ORDER BY x::text)), '') h FROM "${t}" x`); out[`table ${t}`] = `${r.rows[0].n} rows ${r.rows[0].h}` }
    const one = async (k: string, sql: string) => { out[k] = String((await c.query(sql)).rows[0].v) }
    await one('indexes', "SELECT count(*) v FROM pg_indexes WHERE schemaname = 'public'")
    await one('constraints', "SELECT count(*) v FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'")
    await one('triggers', "SELECT count(*) v FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal")
    await one('functions', "SELECT count(*) v FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'")
    return out
  } finally { await c.end() }
}
const run = (cmd: string, args: string[]) => { const r = spawnSync(cmd, args, { encoding: 'utf8' }); if (r.status !== 0) { console.error(`${cmd} failed:\n${r.stderr || r.stdout}`); process.exit(1) } }

const dir = mkdtempSync(join(tmpdir(), 'dl-backup-')), file = join(dir, 'backup.dump'), name = `restore_check_${Date.now()}`
const adminUrl = new URL(admin), target = new URL(admin.toString()); target.pathname = `/${name}`
const root = new pg.Client({ connectionString: adminUrl.href }); await root.connect()
let failed = false
try {
  run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--file=${file}`, src])
  await root.query(`CREATE DATABASE ${name}`)
  run('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', `--dbname=${target.href}`, file])
  const [a, b] = [await fingerprint(src), await fingerprint(target.href)]
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) { failed = true; console.error(`DIFFERENT ${k}\n  source:   ${a[k]}\n  restored: ${b[k]}`) }
  const tables = Object.keys(a).filter((k) => k.startsWith('table ')).length, rows = Object.entries(a).filter(([k]) => k.startsWith('table ')).reduce((s, [, v]) => s + Number(v.split(' ')[0]), 0)
  console.log(failed ? 'RESTORE CHECK FAILED' : `RESTORE CHECK OK: ${tables} tables, ${rows} rows, ${a.indexes} indexes, ${a.constraints} constraints, ${a.triggers} triggers all identical after restore`)
} finally {
  await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined); await root.end(); rmSync(dir, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
