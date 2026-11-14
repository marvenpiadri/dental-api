import { connect } from '@tidbcloud/serverless'
import type { Bindings } from '../env'

/**
 * Create the stateless HTTP-based TiDB connection for this invocation.
 * Do not cache request-specific state or credentials globally.
 */
export function getDb(env: Bindings) {
  if (!env.TIDB_DATABASE_URL) {
    throw new Error('TIDB_DATABASE_URL is not configured')
  }

  return connect({ url: env.TIDB_DATABASE_URL })
}
