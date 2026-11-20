// Starts a throwaway REAL PostgreSQL (embedded-postgres binaries) and prints READY <admin url>. initdb refuses to run as root,
// so tests/pg/setup.ts launches this as the unprivileged user `pgtest` when the suite runs as root (the sandbox). Stops on SIGTERM.
import EmbeddedPostgres from 'embedded-postgres'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'dl-pg-')), port = 54000 + Math.floor(Math.random() * 900)
const pg = new EmbeddedPostgres({ databaseDir: join(dir, 'data'), user: 'postgres', password: 'pw', port, persistent: false, postgresFlags: ['-c', 'max_connections=200', '-c', 'fsync=off'] })
await pg.initialise(); await pg.start()
const stop = async () => { await pg.stop().catch(() => undefined); rmSync(dir, { recursive: true, force: true }); process.exit(0) }
process.on('SIGTERM', stop); process.on('SIGINT', stop)
console.log(`READY postgres://postgres:pw@127.0.0.1:${port}/postgres`)
