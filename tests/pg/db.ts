// A fresh, fully migrated database per test file (real PostgreSQL). Dropped by `drop()`.
import pg from 'pg'
import { pgDb, type PgDb } from '../../src/db/client'
import { migrate } from '../../tools/migrate-lib'

export async function testDb(max = 10): Promise<{ db: PgDb; url: string; drop: () => Promise<void> }> {
  const admin = new URL(process.env.TEST_DATABASE_URL!), name = `t_${crypto.randomUUID().replaceAll('-', '')}`
  const root = new pg.Client({ connectionString: admin.href }); await root.connect()
  await root.query(`CREATE DATABASE ${name}`)
  admin.pathname = `/${name}`
  await migrate(admin.href)
  const db = pgDb(admin.href, { max })
  return { db, url: admin.href, drop: async () => { await db.end(); await root.query(`DROP DATABASE ${name} WITH (FORCE)`); await root.end() } }
}
