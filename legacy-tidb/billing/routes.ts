import { Hono } from 'hono'
import { ApiError } from '../http/errors'
import { authenticate, requires } from '../http/middleware'
import type { AppEnv } from '../http/context'
import { decodeCursor, encodeCursor, page, parseLimit } from '../lib/pagination'
import { formatMoney, parseMoney } from '../lib/money'
import { newId } from '../lib/ids'
import { fromDb, toDb } from '../lib/time'
import { BillingError, balance, cancelInvoice, issueInvoice, type LineInput } from './service'

export const billingRoutes = new Hono<AppEnv>()
billingRoutes.use('*', authenticate)
billingRoutes.onError((e, c) => {
  const x = e instanceof BillingError ? new ApiError(e.code === 'not_found' ? 404 : e.code === 'already_cancelled' || e.code === 'number_conflict' ? 409 : 422, e.code, e.message) : e
  if (x instanceof ApiError) return c.json({ error: { code: x.code, message: x.message }, requestId: c.get('requestId') }, x.status)
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
const iso = (v: unknown): number => {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,3})?)?Z$/.test(v) || !Number.isFinite(Date.parse(v))) throw bad('Times must be UTC ISO strings ending in Z'); return Date.parse(v)
}
const body = async (c: { req: { json: () => Promise<unknown> } }) => { const b = await c.req.json().catch(() => null); if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad(); return b as Record<string, unknown> }
const at = (s: unknown) => (s ? new Date(fromDb(String(s))).toISOString() : null)

async function clinicOf(c: { get: (k: 'db') => import('../db/client').Db; var: unknown }, clinicId: string) {
  const [r] = await (c as never as { get: (k: 'db') => import('../db/client').Db }).get('db').rows<{ timezone: string; currency: string }>('SELECT timezone, currency FROM clinic WHERE id = ?', [clinicId])
  if (!r) throw notFound(); return r
}
async function ownPatient(c: { get: (k: 'db') => import('../db/client').Db }, clinicId: string, id: string) {
  if (!(await c.get('db').rows('SELECT id FROM patient WHERE id = ? AND clinic_id = ?', [id, clinicId])).length) throw notFound()
}
const invView = (r: Record<string, unknown>) => ({ id: r.id, patientId: r.patient_id, kind: r.kind, number: r.number, issuedAt: at(r.issued_at), total: formatMoney(parseMoney(String(r.total))), currency: r.currency,
  cancelsId: r.cancels_id ?? null, cancelledAt: at(r.cancelled_at), cancelReason: r.cancel_reason ?? null })
const payView = (r: Record<string, unknown>) => ({ id: r.id, patientId: r.patient_id, invoiceId: r.invoice_id ?? null, amount: formatMoney(parseMoney(String(r.amount))), method: r.method, at: at(r.at),
  reference: r.reference ?? null, note: r.note ?? null, payerType: r.payer_type ?? null, payerId: r.payer_id ?? null, currency: r.currency, voidedAt: at(r.voided_at), voidReason: r.void_reason ?? null })

/** Newest-first keyset list shared by invoices and payments. */
async function list(c: any, table: 'invoice' | 'payment', col: 'issued_at' | 'at', cols: string, map: (r: Record<string, unknown>) => unknown) {
  const p = c.get('principal'), q = c.req.query(), limit = parseLimit(q.limit); if (limit === null) throw bad('limit must be 1-100')
  const cur = decodeCursor(q.cursor); if (cur === null) throw bad('Invalid cursor')
  await ownPatient(c, p.clinicId, c.req.param('id'))
  const args: unknown[] = [p.clinicId, c.req.param('id')]; let after = ''
  if (cur) { after = `AND (${col} < ? OR (${col} = ? AND id < ?))`; args.push(cur[0], cur[0], cur[1]) }
  args.push(limit + 1)
  const rows = await c.get('db').rows(`SELECT ${cols} FROM ${table} WHERE clinic_id = ? AND patient_id = ?${table === 'invoice' ? ' AND live = 1' : ''} ${after} ORDER BY ${col} DESC, id DESC LIMIT ?`, args)
  const r = page(rows as Record<string, unknown>[], limit, (x) => encodeCursor(String(x[col]), String(x.id)))
  return c.json({ items: r.items.map(map), nextCursor: r.nextCursor })
}
const INV = 'id, patient_id, kind, number, issued_at, total, currency, cancels_id, cancelled_at, cancel_reason'
const PAY = 'id, patient_id, invoice_id, amount, method, at, reference, note, payer_type, payer_id, currency, voided_at, void_reason'

billingRoutes.get('/patients/:id/invoices', requires('billing.view'), (c) => list(c, 'invoice', 'issued_at', INV, invView))
billingRoutes.get('/patients/:id/payments', requires('billing.view'), (c) => list(c, 'payment', 'at', PAY, payView))
billingRoutes.get('/patients/:id/balance', requires('billing.view'), async (c) => {
  const p = c.get('principal'); await ownPatient(c, p.clinicId, c.req.param('id'))
  return c.json({ ...(await balance(c.get('db'), p.clinicId, c.req.param('id'))), currency: (await clinicOf(c as never, p.clinicId)).currency })
})
billingRoutes.get('/invoices/:id', requires('billing.view'), async (c) => {
  const p = c.get('principal'), db = c.get('db')
  const [r] = await db.rows(`SELECT ${INV} FROM invoice WHERE id = ? AND clinic_id = ? AND live = 1`, [c.req.param('id'), p.clinicId]); if (!r) throw notFound()
  const lines = await db.rows('SELECT item_id, label, where_text, price FROM invoice_line WHERE invoice_id = ? AND clinic_id = ? ORDER BY position LIMIT 200', [c.req.param('id'), p.clinicId])
  return c.json({ ...invView(r), lines: lines.map((l) => ({ itemId: l.item_id ?? null, label: l.label, where: l.where_text ?? null, price: formatMoney(parseMoney(String(l.price))) })) })
})

billingRoutes.post('/patients/:id/invoices', requires('billing.create'), async (c) => {
  const p = c.get('principal'), b = await body(c)
  if (!Array.isArray(b.lines) || b.lines.length < 1 || b.lines.length > 200) throw bad('1 to 200 lines')
  const lines: LineInput[] = b.lines.map((l: Record<string, unknown>) => { if (!l || typeof l !== 'object') throw bad(); return { itemId: text(l.itemId, 64), label: text(l.label, 300, true)!, where: text(l.where, 100), price: moneyIn(l.price) } })
  await ownPatient(c, p.clinicId, c.req.param('id'))
  const cl = await clinicOf(c as never, p.clinicId)
  return c.json(await issueInvoice(c.get('db'), { clinicId: p.clinicId, patientId: c.req.param('id'), lines, now: c.get('now'), tz: cl.timezone, currency: cl.currency, staffId: p.staffId }), 201)
})
billingRoutes.post('/invoices/:id/cancel', requires('billing.void'), async (c) => {
  const p = c.get('principal'), b = await body(c), cl = await clinicOf(c as never, p.clinicId)
  return c.json(await cancelInvoice(c.get('db'), { clinicId: p.clinicId, invoiceId: c.req.param('id'), reason: text(b.reason, 500, true)!, now: c.get('now'), tz: cl.timezone, staffId: p.staffId }), 201)
})

billingRoutes.post('/patients/:id/payments', requires('billing.create'), async (c) => {
  const p = c.get('principal'), b = await body(c), db = c.get('db')
  const amount = moneyIn(b.amount); if (parseMoney(amount) <= 0n) throw bad('amount must be more than zero')
  if (typeof b.method !== 'string' || !PAYMENT_METHODS.includes(b.method)) throw bad('Invalid method')
  await ownPatient(c, p.clinicId, c.req.param('id'))
  const invoiceId = text(b.invoiceId, 64)
  if (invoiceId) { // the money settles a live, uncancelled invoice of this same patient in this clinic
    const [i] = await db.rows<{ kind: string; cancelled_at: unknown }>('SELECT kind, cancelled_at FROM invoice WHERE id = ? AND clinic_id = ? AND patient_id = ? AND live = 1', [invoiceId, p.clinicId, c.req.param('id')])
    if (!i) throw notFound(); if (i.kind !== 'invoice' || i.cancelled_at) throw new ApiError(422, 'invalid_invoice', 'Payments can only settle an open invoice')
  }
  const id = newId(), cl = await clinicOf(c as never, p.clinicId)
  await db.run('INSERT INTO payment (id, clinic_id, patient_id, invoice_id, amount, method, at, reference, note, payer_type, payer_id, currency, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, p.clinicId, c.req.param('id'), invoiceId, formatMoney(parseMoney(amount)), b.method, toDb(b.at === undefined ? c.get('now') : iso(b.at)), text(b.reference, 100), text(b.note, 500), text(b.payerType, 32), text(b.payerId, 64), cl.currency, p.staffId])
  return c.json({ id }, 201)
})
// A payment is never deleted: voiding keeps it in history, out of every total.
billingRoutes.post('/payments/:id/void', requires('billing.void'), async (c) => {
  const p = c.get('principal'), b = await body(c)
  const n = await c.get('db').run('UPDATE payment SET voided_at = ?, void_reason = ? WHERE id = ? AND clinic_id = ? AND voided_at IS NULL', [toDb(c.get('now')), text(b.reason, 500, true), c.req.param('id'), p.clinicId])
  if (n !== 1) throw notFound()
  return c.body(null, 204)
})
