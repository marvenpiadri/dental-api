// TEST DOUBLE ONLY. Translates the real MySQL migration to in-memory SQLite so our request/SQL logic can run without TiDB.
// It proves our logic, NOT TiDB dialect compatibility (that is tests/tidb, which needs a real cluster).
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { DuplicateKeyError, type Db } from '../../src/db/client'

const translate = (mysql: string) => mysql.replace(/--.*$/gm, '').split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean).map((s) => s
  .replace(/\b(?:VAR)?CHAR\(\d+\)/g, 'TEXT').replace(/DATETIME\(3\)/g, 'TEXT').replace(/\bJSON\b/g, 'TEXT').replace(/\bDATE\b/g, 'TEXT').replace(/\bINT\b/g, 'INTEGER')
  .replace(/^\s*UNIQUE KEY \w+ \(/gm, '  UNIQUE (').replace(/^\s*KEY \w+ \([^)]*\),?\n/gm, '').replace(/,\s*\)\s*$/, '\n)'))

export function sqliteDb(): Db & { raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:')
  for (const f of readdirSync('db/migrations').sort()) for (const s of translate(readFileSync(`db/migrations/${f}`, 'utf8'))) raw.exec(s)
  const wrap = <T>(f: () => T): T => { try { return f() } catch (e) { throw /UNIQUE constraint/.test(String(e)) ? new DuplicateKeyError() : e } }
  return {
    raw,
    rows: async (sql, p = []) => wrap(() => raw.prepare(sql).all(...(p as never[]))) as never,
    run: async (sql, p = []) => wrap(() => Number(raw.prepare(sql).run(...(p as never[])).changes)),
  }
}
