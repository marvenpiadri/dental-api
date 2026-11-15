import { connect } from '@tidbcloud/serverless'
import type { Bindings } from '../env'

/**
 * Database access. Verified from @tidbcloud/serverless 0.3.0 source (docs/architecture.md §0):
 *  - `?` parameters are interpolated CLIENT-side (the driver escapes values; there are no server-side prepared statements),
 *    including any `?` inside string literals. So SQL here must never contain a literal `?`, and we assert placeholder count == param count.
 *  - the driver sets no timeout/AbortSignal, so we pass our own `fetch` with one.
 *  - one statement per call; at most 10,000 rows per result.
 * Interactive transactions (`begin`) are deliberately NOT exposed until tests/tidb proves their behaviour (docs §5).
 */
export type Row = Record<string, unknown>
export interface Db {
  rows<T extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<T[]>
  /** Rows affected by INSERT/UPDATE/DELETE. */
  run(sql: string, params?: readonly unknown[]): Promise<number>
}

export const DB_TIMEOUT_MS = 8_000
export const MAX_ROWS = 10_000

export class DuplicateKeyError extends Error { constructor() { super('duplicate key') } }
export class DbError extends Error {} // message is safe to log, never returned to clients

export function checkPlaceholders(sql: string, params: readonly unknown[]): void {
  const n = sql.split('?').length - 1
  if (n !== params.length) throw new DbError(`placeholder/parameter mismatch (${n} vs ${params.length})`)
  for (const p of params) if (typeof p === 'number' && !Number.isFinite(p)) throw new DbError('non-finite number parameter')
}

// DATETIME/DATE/TIMESTAMP stay strings (UTC 'YYYY-MM-DD HH:MM:SS.mmm'); DECIMAL/BIGINT are already strings in the driver (never floats).
const decoders = { DATETIME: (v: string) => v, TIMESTAMP: (v: string) => v, DATE: (v: string) => v }

const timeoutFetch = (ms: number): typeof fetch => (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(ms) })

function mapError(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e)
  if (/Duplicate entry|\b1062\b/.test(msg)) throw new DuplicateKeyError()
  throw new DbError(msg.slice(0, 300))
}

export function getDb(env: Pick<Bindings, 'TIDB_DATABASE_URL'>, opts: { timeoutMs?: number; fetch?: typeof fetch } = {}): Db {
  if (!env.TIDB_DATABASE_URL) throw new DbError('TIDB_DATABASE_URL is not configured')
  const conn = connect({ url: env.TIDB_DATABASE_URL, decoders, fullResult: true, fetch: opts.fetch ?? timeoutFetch(opts.timeoutMs ?? DB_TIMEOUT_MS) })
  const exec = async (sql: string, params: readonly unknown[]) => {
    checkPlaceholders(sql, params)
    try { return await conn.execute(sql, params as unknown[]) } catch (e) { return mapError(e) }
  }
  return {
    rows: async (sql, params = []) => (((await exec(sql, params)) as { rows?: unknown[] }).rows ?? []) as never,
    run: async (sql, params = []) => Number(((await exec(sql, params)) as { rowsAffected?: number }).rowsAffected ?? 0),
  }
}
