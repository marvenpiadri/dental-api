import type { Db } from '../db/client'
import type { FileStore } from './store'
import { PURPOSES } from './purposes'

const REPLACEABLE = Object.entries(PURPOSES).filter(([, p]) => !p.retain).map(([k]) => k)
const PENDING_MS = 60 * 60_000 // an upload URL lives 10 minutes; anything still pending an hour later is abandoned

/** Deletes the bytes, then the row. A failure leaves the row, so the next purge retries: a file is never forgotten while its bytes exist. Clinical (retained) files are never touched. */
export async function reap(db: Db, store: FileStore, rows: { id: string; r2_key: string }[]): Promise<number> {
  let n = 0
  for (const r of rows) {
    try {
      await store.delete(r.r2_key)
      n += await db.run("DELETE FROM file WHERE id = $1 AND (status = 'pending' OR purpose = ANY($2::text[]))", [r.id, REPLACEABLE])
    } catch { /* retried by the next purge */ }
  }
  return n
}

/** Abandoned uploads and removed/replaced pictures. Runs on a schedule (index.ts) and is safe to run any time, any number of times. */
export async function purgeFiles(db: Db, store: FileStore, now: number): Promise<number> {
  const rows = await db.rows<{ id: string; r2_key: string }>(
    "SELECT id, r2_key FROM file WHERE (status = 'pending' AND created_at < $1) OR (voided_at IS NOT NULL AND purpose = ANY($2::text[])) ORDER BY created_at LIMIT 200",
    [new Date(now - PENDING_MS), REPLACEABLE])
  return reap(db, store, rows)
}
