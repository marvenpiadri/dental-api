import { Hono } from 'hono'
import { ApiError, fail } from '../http/errors'
import { authenticate, requires } from '../http/middleware'
import type { AppEnv } from '../http/context'
import type { Db } from '../db/client'
import { decodeCursor, encodeCursor, page, parseLimit } from '../lib/pagination'
import { formatMoney, parseMoney } from '../lib/money'
import { isUuid } from '../lib/ids'
import { BillingError, balance, cancelInvoice, issueInvoice, recordPayment, recordRefund, type LineInput } from './service'

export const billingRoutes = new Hono<AppEnv>()
billingRoutes.use('*', authenticate)
billingRoutes.onError((e, c) => {
  if (e instanceof BillingError) return fail(c, new ApiError(e.code === 'not_found' ? 404 : e.code === 'already_cancelled' ? 409 : 422, e.code, e.message))
  if (e instanceof ApiError) return fail(c, e)
  throw e
})

const bad = (m = 'Invalid request') => new ApiError(400, 'bad_request', m)
const notFound = () => new ApiError(404, 'not_found', 'Not found')
const PAYMENT_METHODS = ['cash', 'card', 'transfer', 'cheque', 'other']
/** Money in: a decimal string or a JSON number with at most 2 decimals. Never rounded. */
const moneyIn = (v: unknown): string => {
  const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : v
  if (typeof s !== 'string' || !/^-?\d{1,10}(\.\d{1,2})?$/.test(s)) throw bad('Invalid amount')
  return s
}
const text = (v: unknown, max: number, required = false): string | null => {
  if (v === undefined || v === null || v === '') { if (required) throw bad(); return null }
  if (typeof v !== 'string' || v.length > max) throw bad(); return v.trim()
}
const optUuid = (v: unknown): string | null => { if (v === undefined || v === null || v === '') return null; if (typeof v !== 'string' || !isUuid(v)) throw bad(); return v }
const iso = (v: unknown): number => {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,3})?)?Z$/.test(v) || !Number.isFinite(Date.parse(v))) throw bad('Times must be UTC ISO strings ending in Z'); return Date.parse(v)
}
const day = (v: unknown): string | null => { if (v === undefined || v === null || v === '') return null; if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(v) || Number.isNaN(Date.parse(v))) throw bad('dueOn must be YYYY-MM-DD'); return v }
const body = async (c: { req: { json: () => Promise<unknown> } }) => { const b = await c.req.json().catch(() => null); if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad(); return b as Record<string, unknown> }
const money = (v: unknown) => formatMoney(parseMoney(String(v)))
const method = (v: unknown) => { if (typeof v !== 'string' || !PAYMENT_METHODS.includes(v)) throw bad('Invalid method'); return v }

const clinicOf = async (db: Db, id: string) => { const [r] = await db.rows<{ timezone: string; currency: string }>('SELECT timezone, currency FROM clinic WHERE id = $1', [id]); if (!r) throw notFound(); return r }
const ownPatient = async (db: Db, clinicId: string, id: string) => { if (!isUuid(id) || !(await db.rows('SELECT 1 FROM patient WHERE id = $1 AND clinic_id = $2', [id, clinicId])).length) throw notFound() }

const invView = (r: Record<string, unknown>) => ({ id: r.id, patientId: r.patient_id, kind: r.kind, number: r.number, issuedAt: r.issued_at, dueOn: r.due_on ?? null, total: money(r.total), currency: r.currency,
  cancelsId: r.cancels_id ?? null, cancelledAt: r.cancelled_at ?? null, cancelReason: r.cancel_reason ?? null })
const payView = (r: Record<string, unknown>) => ({ id: r.id, patientId: r.patient_id, invoiceId: r.invoice_id ?? null, amount: money(r.amount), method: r.method, at: r.at,
  reference: r.reference ?? null, note: r.note ?? null, payerType: r.payer_type ?? null, payerId: r.payer_id ?? null, currency: r.currency, voidedAt: r.voided_at ?? null, voidReason: r.void_reason ?? null })

/** Newest-first keyset list shared by invoices and payments. */
async function list(c: any, table: 'invoice' | 'payment', col: 'issued_at' | 'at', cols: string, map: (r: Record<string, unknown>) => unknown) {
  const p = c.get('principal'), q = c.req.query(), limit = parseLimit(q.limit); if (limit === null) throw bad('limit must be 1-100')
  const cur = decodeCursor(q.cursor); if (cur === null || (cur && (!isUuid(cur[1]) || Number.isNaN(Date.parse(cur[0]))))) throw bad('Invalid cursor')
  await ownPatient(c.get('db'), p.clinicId, c.req.param('id'))
  const args: unknown[] = [p.clinicId, c.req.param('id')]; let after = ''
  if (cur) { args.push(cur[0], cur[1]); after = `AND (${col}, id) < ($3::timestamptz, $4::uuid)` }
  args.push(limit + 1)
  const rows = await c.get('db').rows(`SELECT ${cols} FROM ${table} WHERE clinic_id = $1 AND patient_id = $2 ${after} ORDER BY ${col} DESC, id DESC LIMIT $${args.length}`, args)
  const r = page(rows as Record<string, unknown>[], limit, (x) => encodeCursor(String(x[col]), String(x.id)))
  return c.json({ items: r.items.map(map), nextCursor: r.nextCursor })
}
const INV = 'id, patient_id, kind, number, issued_at, due_on, total, currency, cancels_id, cancelled_at, cancel_reason'
const PAY = 'id, patient_id, invoice_id, amount, method, at, reference, note, payer_type, payer_id, currency, voided_at, void_reason'

billingRoutes.get('/patients/:id/invoices', requires('billing.view'), (c) => list(c, 'invoice', 'issued_at', INV, invView))
billingRoutes.get('/patients/:id/payments', requires('billing.view'), (c) => list(c, 'payment', 'at', PAY, payView))
billingRoutes.get('/patients/:id/balance', requires('billing.view'), async (c) => {
  const p = c.get('principal'), db = c.get('db'); await ownPatient(db, p.clinicId, c.req.param('id'))
  return c.json({ ...(await balance(db, p.clinicId, c.req.param('id'))), currency: (await clinicOf(db, p.clinicId)).currency })
})
billingRoutes.get('/invoices/:id', requires('billing.view'), async (c) => {
  const p = c.get('principal'), db = c.get('db'), id = c.req.param('id'); if (!isUuid(id)) throw notFound()
  const [r] = await db.rows(`SELECT ${INV} FROM invoice WHERE id = $1 AND clinic_id = $2`, [id, p.clinicId]); if (!r) throw notFound()
  const lines = await db.rows('SELECT item_id, label, where_text, price FROM invoice_line WHERE invoice_id = $1 ORDER BY position LIMIT 200', [id])
  const refunds = r.kind === 'credit-note' ? await db.rows('SELECT id, amount, method, at, reference FROM refund WHERE credit_note_id = $1 ORDER BY at, id LIMIT 200', [id]) : []
  return c.json({ ...invView(r), lines: lines.map((l) => ({ itemId: l.item_id ?? null, label: l.label, where: l.where_text ?? null, price: money(l.price) })),
    ...(r.kind === 'credit-note' && { refunds: refunds.map((x) => ({ id: x.id, amount: money(x.amount), method: x.method, at: x.at, reference: x.reference ?? null })) }) })
})

billingRoutes.post('/patients/:id/invoices', requires('billing.create'), async (c) => {
  const p = c.get('principal'), b = await body(c), db = c.get('db')
  if (!Array.isArray(b.lines) || b.lines.length < 1 || b.lines.length > 200) throw bad('1 to 200 lines')
  const lines: LineInput[] = b.lines.map((l: Record<string, unknown>) => { if (!l || typeof l !== 'object') throw bad(); return { itemId: optUuid(l.itemId), label: text(l.label, 300, true)!, where: text(l.where, 100), price: moneyIn(l.price) } })
  await ownPatient(db, p.clinicId, c.req.param('id'))
  const cl = await clinicOf(db, p.clinicId)
  return c.json(await issueInvoice(db, { clinicId: p.clinicId, patientId: c.req.param('id'), lines, now: c.get('now'), tz: cl.timezone, currency: cl.currency, staffId: p.staffId, dueOn: day(b.dueOn) }), 201)
})
billingRoutes.post('/invoices/:id/cancel', requires('billing.void'), async (c) => {
  const p = c.get('principal'), b = await body(c), db = c.get('db'), id = c.req.param('id'); if (!isUuid(id)) throw notFound()
  const reason = text(b.reason, 500, true)!, cl = await clinicOf(db, p.clinicId)
  return c.json(await cancelInvoice(db, { clinicId: p.clinicId, invoiceId: id, reason, now: c.get('now'), tz: cl.timezone, staffId: p.staffId }), 201)
})

billingRoutes.post('/patients/:id/payments', requires('billing.create'), async (c) => {
  const p = c.get('principal'), b = await body(c), db = c.get('db')
  const amount = moneyIn(b.amount); if (parseMoney(amount) <= 0n) throw bad('amount must be more than zero')
  const m = method(b.method), invoiceId = optUuid(b.invoiceId), payerId = optUuid(b.payerId)
  await ownPatient(db, p.clinicId, c.req.param('id'))
  const id = await recordPayment(db, { clinicId: p.clinicId, patientId: c.req.param('id'), invoiceId, amount: money(amount), method: m, at: b.at === undefined ? c.get('now') : iso(b.at), reference: text(b.reference, 100), note: text(b.note, 500), payerType: text(b.payerType, 32), payerId, staffId: p.staffId })
  return c.json({ id }, 201)
})
// A payment is never deleted: voiding keeps it in history, out of every total.
billingRoutes.post('/payments/:id/void', requires('billing.void'), async (c) => {
  const p = c.get('principal'), b = await body(c), id = c.req.param('id'); if (!isUuid(id)) throw notFound()
  const reason = text(b.reason, 500, true)
  const n = await c.get('db').run('UPDATE payment SET voided_at = $1, void_reason = $2 WHERE id = $3 AND clinic_id = $4 AND voided_at IS NULL', [new Date(c.get('now')), reason, id, p.clinicId])
  if (n !== 1) throw notFound()
  return c.body(null, 204)
})
// Refunds are recorded against the credit note, capped at what was paid on the cancelled invoice.
billingRoutes.post('/invoices/:id/refunds', requires('billing.void'), async (c) => {
  const p = c.get('principal'), b = await body(c), id = c.req.param('id'); if (!isUuid(id)) throw notFound()
  const amount = moneyIn(b.amount); if (parseMoney(amount) <= 0n) throw bad('amount must be more than zero')
  const rid = await recordRefund(c.get('db'), { clinicId: p.clinicId, creditNoteId: id, amount: money(amount), method: method(b.method), at: b.at === undefined ? c.get('now') : iso(b.at), reference: text(b.reference, 100), staffId: p.staffId })
  return c.json({ id: rid }, 201)
})
