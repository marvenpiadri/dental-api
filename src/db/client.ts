import pg from 'pg'

/** PostgreSQL access (docs/postgres-architecture.md §3). Parameters are `$1, $2…`; values are never interpolated into SQL. */
export type Row = Record<string, unknown>
export interface Db {
  rows<T extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<T[]>
  /** Rows affected by INSERT/UPDATE/DELETE. */
  run(sql: string, params?: readonly unknown[]): Promise<number>
  /** One transaction on one connection; commits when `fn` returns, rolls back when it throws. Use only the `db` it is given. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>
}

export class DuplicateKeyError extends Error { constructor() { super('duplicate key') } }
export class DbError extends Error {} // message is safe to log, never returned to clients

// timestamptz -> ISO string (UTC); date -> 'YYYY-MM-DD'; numeric and int8 stay strings (never floats).
const types = { getTypeParser: (oid: number, fmt?: 'text' | 'binary') => (oid === 1184 ? (v: string) => new Date(v).toISOString() : oid === 1082 ? (v: string) => v : pg.types.getTypeParser(oid, fmt as 'text')) } as pg.CustomTypesConfig

function mapError(e: unknown): never {
  if (!(e instanceof pg.DatabaseError)) throw e // our own errors (ApiError, DuplicateKeyError) pass through a transaction untouched
  const code = e.code
  if (code === '23505') throw new DuplicateKeyError()
  throw new DbError(`${code}: ${e.message.slice(0, 300)}`)
}

type Queryable = Pick<pg.PoolClient, 'query'>
const over = (q: Queryable, tx: Db['tx']): Db => ({
  rows: async (sql, params = []) => { try { return (await q.query(sql, params as unknown[])).rows } catch (e) { return mapError(e) } },
  run: async (sql, params = []) => { try { return (await q.query(sql, params as unknown[])).rowCount ?? 0 } catch (e) { return mapError(e) } },
  tx,
})

export type PgDb = Db & { end(): Promise<void> }

/**
 * Lazy pool. In a Worker use the Hyperdrive string and a small `max` (one request, one or two connections), then
 * `ctx.waitUntil(db.end())`. Hyperdrive does the real pooling; the direct (non-pooled) Neon string goes into Hyperdrive.
 */
export function pgDb(connectionString: string, opts: { max?: number; statementTimeoutMs?: number } = {}): PgDb {
  if (!connectionString) throw new DbError('database connection string is not configured')
  let pool: pg.Pool | undefined
  const get = () => (pool ??= new pg.Pool({ connectionString, max: opts.max ?? 2, types, statement_timeout: opts.statementTimeoutMs ?? 10_000, connectionTimeoutMillis: 8_000 }).on('error', () => undefined)) // an idle connection dropped by the server must not crash the Worker; the next query reconnects
  const tx: Db['tx'] = async (fn) => {
    const client = await get().connect()
    const nested: Db = { ...over(client, () => { throw new DbError('nested transactions are not supported') }) }
    try {
      await client.query('BEGIN')
      const out = await fn(nested)
      await client.query('COMMIT')
      return out
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined)
      return mapError(e)
    } finally { client.release() }
  }
  return { ...over({ query: ((...a: unknown[]) => (get().query as (...x: unknown[]) => unknown)(...a)) as never }, tx), end: async () => { await pool?.end(); pool = undefined } }
}
