import type { Db } from '../db/client'
import { formatMoney, parseMoney, sum } from '../lib/money'
import { newId } from '../lib/ids'
import { nextSeq } from '../lib/numbering'
import { toDb } from '../lib/time'

export class BillingError extends Error { code: string; constructor(code: string, message: string) { super(message); this.code = code } }

export type LineInput = { itemId?: string | null; label: string; where?: string | null; price: string }
const MAX_LINES = 200

/** Year of an instant in the clinic's time zone (numbers restart on 1 January local time). */
export const yearIn = (tz: string, ms: number): number => Number(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric' }).format(ms))
export const formatNumber = (kind: 'invoice' | 'credit-note', year: number, seq: number) => `${kind === 'invoice' ? 'FA' : 'AV'}-${year}-${String(seq).padStart(4, '0')}`

type IssueIn = { clinicId: string; patientId: string; kind: 'invoice' | 'credit-note'; lines: LineInput[]; now: number; tz: string; currency: string; staffId: string | null; cancelsId?: string; dueOn?: string | null }
/** Issues a document inside the caller's transaction: counter, header and lines commit together or not at all (gap-free numbers). */
async function issue(db: Db, o: IssueIn): Promise<{ id: string; number: string }> {
  if (!o.lines.length || o.lines.length > MAX_LINES) throw new BillingError('invalid_lines', `1 to ${MAX_LINES} lines`)
  const prices = o.lines.map((l) => parseMoney(l.price))
  if (o.kind === 'invoice' && prices.some((p) => p < 0n)) throw new BillingError('invalid_lines', 'prices cannot be negative')
  const total = sum(prices), year = yearIn(o.tz, o.now), id = newId()
  const seq = await nextSeq(db, o.clinicId, o.kind, year), number = formatNumber(o.kind, year, seq)
  await db.run('INSERT INTO invoice (id, clinic_id, patient_id, kind, number_year, seq, number, issued_at, due_on, total, currency, cancels_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
    [id, o.clinicId, o.patientId, o.kind, year, seq, number, toDb(o.now), o.dueOn ?? null, formatMoney(total), o.currency, o.cancelsId ?? null, o.staffId])
  await db.run(`INSERT INTO invoice_line (invoice_id, position, clinic_id, item_id, label, where_text, price) VALUES ${o.lines.map((_, i) => `($1, ${i}, $2, $${i * 4 + 3}, $${i * 4 + 4}, $${i * 4 + 5}, $${i * 4 + 6})`).join(', ')}`,
    [id, o.clinicId, ...o.lines.flatMap((l, i) => [l.itemId ?? null, l.label, l.where ?? null, formatMoney(prices[i])])])
  return { id, number }
}
export const issueInvoice = (db: Db, o: Omit<IssueIn, 'kind' | 'cancelsId'>) => db.tx((q) => issue(q, { ...o, kind: 'invoice' }))

/** Cancelling = a credit note with negated lines, in one transaction. The row lock plus the unique index on cancels_id make a double cancel impossible. */
export function cancelInvoice(db: Db, o: { clinicId: string; invoiceId: string; reason: string; now: number; tz: string; staffId: string | null }) {
  return db.tx(async (q) => {
    const [inv] = await q.rows<{ patient_id: string; kind: string; cancelled_at: string | null; currency: string }>('SELECT patient_id, kind, cancelled_at, currency FROM invoice WHERE id = $1 AND clinic_id = $2 FOR UPDATE', [o.invoiceId, o.clinicId])
    if (!inv) throw new BillingError('not_found', 'Not found')
    if (inv.kind !== 'invoice') throw new BillingError('invalid', 'Only invoices can be cancelled')
    if (inv.cancelled_at) throw new BillingError('already_cancelled', 'Already cancelled')
    await q.run('UPDATE invoice SET cancelled_at = $1, cancel_reason = $2 WHERE id = $3', [toDb(o.now), o.reason, o.invoiceId])
    const lines = await q.rows<{ item_id: string | null; label: string; where_text: string | null; price: string }>('SELECT item_id, label, where_text, price FROM invoice_line WHERE invoice_id = $1 ORDER BY position LIMIT 200', [o.invoiceId])
    return issue(q, { clinicId: o.clinicId, patientId: inv.patient_id, kind: 'credit-note', now: o.now, tz: o.tz, currency: inv.currency, staffId: o.staffId, cancelsId: o.invoiceId,
      lines: lines.map((l) => ({ itemId: l.item_id, label: l.label, where: l.where_text, price: formatMoney(-parseMoney(String(l.price))) })) })
  })
}

/** Records a payment. The invoice row is locked in share mode so a concurrent cancel cannot slip between the check and the insert. */
export function recordPayment(db: Db, o: { clinicId: string; patientId: string; invoiceId: string | null; amount: string; method: string; at: number; reference: string | null; note: string | null; payerType: string | null; payerId: string | null; staffId: string | null }) {
  return db.tx(async (q) => {
    if (o.invoiceId) {
      const [i] = await q.rows<{ kind: string; cancelled_at: string | null }>('SELECT kind, cancelled_at FROM invoice WHERE id = $1 AND clinic_id = $2 AND patient_id = $3 FOR SHARE', [o.invoiceId, o.clinicId, o.patientId])
      if (!i) throw new BillingError('not_found', 'Not found')
      if (i.kind !== 'invoice' || i.cancelled_at) throw new BillingError('invalid_invoice', 'Payments can only settle an open invoice')
    }
    const [c] = await q.rows<{ currency: string }>('SELECT currency FROM clinic WHERE id = $1', [o.clinicId]), id = newId()
    await q.run('INSERT INTO payment (id, clinic_id, patient_id, invoice_id, amount, method, at, reference, note, payer_type, payer_id, currency, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [id, o.clinicId, o.patientId, o.invoiceId, o.amount, o.method, toDb(o.at), o.reference, o.note, o.payerType, o.payerId, c.currency, o.staffId])
    return id
  })
}

/** What can still be handed back on a credit note: paid on the cancelled invoice (not voided) minus refunds already made. Locks the credit note, so concurrent refunds cannot exceed it. */
export function recordRefund(db: Db, o: { clinicId: string; creditNoteId: string; amount: string; method: string; at: number; reference: string | null; staffId: string | null }) {
  return db.tx(async (q) => {
    const [n] = await q.rows<{ kind: string; cancels_id: string | null }>('SELECT kind, cancels_id FROM invoice WHERE id = $1 AND clinic_id = $2 FOR UPDATE', [o.creditNoteId, o.clinicId])
    if (!n) throw new BillingError('not_found', 'Not found')
    if (n.kind !== 'credit-note') throw new BillingError('invalid', 'Refunds are recorded against a credit note')
    const [p] = await q.rows<{ t: string }>('SELECT COALESCE(SUM(amount), 0) AS t FROM payment WHERE invoice_id = $1 AND voided_at IS NULL', [n.cancels_id])
    const [r] = await q.rows<{ t: string }>('SELECT COALESCE(SUM(amount), 0) AS t FROM refund WHERE credit_note_id = $1', [o.creditNoteId])
    const left = parseMoney(p.t) - parseMoney(r.t)
    if (parseMoney(o.amount) > left) throw new BillingError('refund_too_large', `At most ${formatMoney(left < 0n ? 0n : left)} can still be refunded`)
    const id = newId()
    await q.run('INSERT INTO refund (id, clinic_id, credit_note_id, amount, method, at, reference, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id, o.clinicId, o.creditNoteId, o.amount, o.method, toDb(o.at), o.reference, o.staffId])
    return id
  })
}

/** Net billed (invoices + credit notes) minus received (non-voided payments minus refunds). All sums exact. */
export async function balance(db: Db, clinicId: string, patientId: string) {
  const [b] = await db.rows<{ t: string }>('SELECT COALESCE(SUM(total), 0) AS t FROM invoice WHERE clinic_id = $1 AND patient_id = $2', [clinicId, patientId])
  const [p] = await db.rows<{ t: string }>('SELECT COALESCE(SUM(amount), 0) AS t FROM payment WHERE clinic_id = $1 AND patient_id = $2 AND voided_at IS NULL', [clinicId, patientId])
  const [r] = await db.rows<{ t: string }>('SELECT COALESCE(SUM(f.amount), 0) AS t FROM refund f JOIN invoice i ON i.id = f.credit_note_id WHERE f.clinic_id = $1 AND i.patient_id = $2', [clinicId, patientId])
  const billed = parseMoney(b.t), paid = parseMoney(p.t) - parseMoney(r.t)
  return { billed: formatMoney(billed), paid: formatMoney(paid), due: formatMoney(billed - paid) }
}
