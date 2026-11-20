import type { Db } from '../db/client'

/** Next gap-free number for (clinic, kind, year). Call inside the issuing transaction: the counter row is locked until it commits, so no two callers get the same number and a rollback gives the number back. */
export async function nextSeq(db: Db, clinicId: string, kind: string, year = 0): Promise<number> {
  const [r] = await db.rows<{ last_seq: number }>(
    'INSERT INTO doc_counter (clinic_id, kind, year, last_seq) VALUES ($1, $2, $3, 1) ON CONFLICT (clinic_id, kind, year) DO UPDATE SET last_seq = doc_counter.last_seq + 1 RETURNING last_seq', [clinicId, kind, year])
  return r.last_seq
}
export const patientNumber = (n: number) => `P-${String(n).padStart(4, '0')}`
