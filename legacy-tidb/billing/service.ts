import { DuplicateKeyError, type Db } from '../db/client'
import { formatMoney, parseMoney, sum } from '../lib/money'
import { newId } from '../lib/ids'
import { toDb } from '../lib/time'

export class BillingError extends Error { constructor(public code: string, message: string) { super(message) } }

export type LineInput = { itemId?: string | null; label: string; where?: string | null; price: string }
const MAX_LINES = 200

/** Year of an instant in the clinic's time zone (invoice numbers restart on 1 January local time). */
export const yearIn = (tz: string, ms: number): number => Number(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric' }).format(ms))
export const formatNumber = (kind: 'invoice' | 'credit-note', year: number, seq: number) => `${kind === 'invoice' ? 'FA' : 'AV'}-${year}-${String(seq).padStart(4, '0')}`

/** Issues a document: pick MAX(seq)+1, INSERT the header (the unique key is the arbiter; retry on a clash), insert lines, then mark it live. */
async function issue(db: Db, o: { clinicId: string; patientId: string; kind: 'invoice' | 'credit-note'; lines: LineInput[]; now: number; tz: string; currency: string; staffId: string | null; cancelsId?: string }): Promise<{ id: string; number: string }> {
  if (!o.lines.length || o.lines.length > MAX_LINES) throw new BillingError('invalid_lines', `1 to ${MAX_LINES} lines`)
  const prices = o.lines.map((l) => parseMoney(l.price))
  if (o.kind === 'invoice' && prices.some((p) => p < 0n)) throw new BillingError('invalid_lines', 'prices cannot be negative')
  const total = sum(prices), year = yearIn(o.tz, o.now), id = newId()
  for (let attempt = 0; attempt < 6; attempt++) {
    const [m] = await db.rows<{ s: unknown }>('SELECT COALESCE(MAX(seq), 0) AS s FROM invoice WHERE clinic_id = ? AND kind = ? AND number_year = ?', [o.clinicId, o.kind, year])
    const seq = Number(m?.s ?? 0) + 1, number = formatNumber(o.kind, year, seq)
    try {
      await db.run('INSERT INTO invoice (id, clinic_id, patient_id, kind, number_year, seq, number, issued_at, total, currency, cancels_id, live, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)',
        [id, o.clinicId, o.patientId, o.kind, year, seq, number, toDb(o.now), formatMoney(total), o.currency, o.cancelsId ?? null, o.staffId])
    } catch (e) { if (e instanceof DuplicateKeyError) continue; throw e }
    try {
      await db.run(`INSERT INTO invoice_line (invoice_id, position, clinic_id, item_id, label, where_text, price) VALUES ${o.lines.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        o.lines.flatMap((l, i) => [id, i, o.clinicId, l.itemId ?? null, l.label, l.where ?? null, formatMoney(prices[i])]))
      if ((await db.run('UPDATE invoice SET live = 1 WHERE id = ? AND clinic_id = ? AND live = 0', [id, o.clinicId])) !== 1) throw new Error('could not activate invoice')
    } catch (e) { // the number is kept by the dead header: a gap, never a reused number
      await db.run('DELETE FROM invoice_line WHERE invoice_id = ? AND clinic_id = ?', [id, o.clinicId]).catch(() => undefined); throw e
    }
    return { id, number }
  }
  throw new BillingError('number_conflict', 'Could not allocate an invoice number, try again')
}
export const issueInvoice = (db: Db, o: Omit<Parameters<typeof issue>[1], 'kind' | 'cancelsId'>) => issue(db, { ...o, kind: 'invoice' })

type Inv = { id: string; patient_id: string; kind: string; cancelled_at: string | null; currency: string }
/** Cancelling = a credit note with negated lines. The conditional UPDATE on the original is the arbiter against a double cancel. */
export async function cancelInvoice(db: Db, o: { clinicId: string; invoiceId: string; reason: string; now: number; tz: string; staffId: string | null }) {
  const [inv] = await db.rows<Inv>('SELECT id, patient_id, kind, cancelled_at, currency FROM invoice WHERE id = ? AND clinic_id = ? AND live = 1', [o.invoiceId, o.clinicId])
  if (!inv) throw new BillingError('not_found', 'Not found')
  if (inv.kind !== 'invoice') throw new BillingError('invalid', 'Only invoices can be cancelled')
  if ((await db.run('UPDATE invoice SET cancelled_at = ?, cancel_reason = ? WHERE id = ? AND clinic_id = ? AND cancelled_at IS NULL', [toDb(o.now), o.reason, o.invoiceId, o.clinicId])) !== 1) throw new BillingError('already_cancelled', 'Already cancelled')
  try {
    const lines = await db.rows<{ item_id: string | null; label: string; where_text: string | null; price: string }>('SELECT item_id, label, where_text, price FROM invoice_line WHERE invoice_id = ? AND clinic_id = ? ORDER BY position LIMIT 200', [o.invoiceId, o.clinicId])
    return await issue(db, { clinicId: o.clinicId, patientId: inv.patient_id, kind: 'credit-note', now: o.now, tz: o.tz, currency: inv.currency, staffId: o.staffId, cancelsId: o.invoiceId,
      lines: lines.map((l) => ({ itemId: l.item_id, label: l.label, where: l.where_text, price: formatMoney(-parseMoney(String(l.price))) })) })
  } catch (e) { await db.run('UPDATE invoice SET cancelled_at = NULL, cancel_reason = NULL WHERE id = ? AND clinic_id = ?', [o.invoiceId, o.clinicId]).catch(() => undefined); throw e }
}

/** Net billed (invoices + credit notes) minus received (non-voided payments). All sums exact. */
export async function balance(db: Db, clinicId: string, patientId: string) {
  const [b] = await db.rows<{ t: string | null }>('SELECT COALESCE(SUM(total), 0) AS t FROM invoice WHERE clinic_id = ? AND patient_id = ? AND live = 1', [clinicId, patientId])
  const [p] = await db.rows<{ t: string | null }>('SELECT COALESCE(SUM(amount), 0) AS t FROM payment WHERE clinic_id = ? AND patient_id = ? AND voided_at IS NULL', [clinicId, patientId])
  const billed = parseMoney(String(b?.t ?? '0')), paid = parseMoney(String(p?.t ?? '0'))
  return { billed: formatMoney(billed), paid: formatMoney(paid), due: formatMoney(billed - paid) }
}
