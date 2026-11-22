import { Hono } from 'hono'
import { ApiError, fail } from '../http/errors'
import { authenticate, requires } from '../http/middleware'
import type { AppEnv } from '../http/context'
import type { Db } from '../db/client'
import { decodeCursor, encodeCursor, page, parseLimit } from '../lib/pagination'
import { formatMoney, parseMoney } from '../lib/money'
import { isUuid, newId } from '../lib/ids'
import { toDb } from '../lib/time'

/** Practice management: expenses, stock (with a ledger), lab orders, tasks, implant and sterilization records, equipment. Every list is paged. */
export const practiceRoutes = new Hono<AppEnv>()
practiceRoutes.use('*', authenticate)
practiceRoutes.onError((e, c) => { if (e instanceof ApiError) return fail(c, e); throw e })
const bad = (m = 'Invalid request') => new ApiError(400, 'bad_request', m)
const notFound = () => new ApiError(404, 'not_found', 'Not found')
const body = async (c: { req: { json: () => Promise<unknown> } }) => { const b = await c.req.json().catch(() => null); if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad(); return b as Record<string, unknown> }
const str = (v: unknown, max: number, required = false): string | null => { if (v === undefined || v === null || v === '') { if (required) throw bad(); return null } if (typeof v !== 'string' || v.length > max) throw bad(); const t = v.trim(); if (!t && required) throw bad(); return t || null }
const day = (v: unknown, required = true): string | null => { if (v === undefined || v === null) { if (required) throw bad('A date (YYYY-MM-DD) is required'); return null } if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z')) || new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) !== v) throw bad('Dates must be YYYY-MM-DD'); return v }
const today = (now: number) => new Date(now).toISOString().slice(0, 10)
const money = (v: unknown, allowZero = false): string => { const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : v; if (typeof s !== 'string' || !/^\d{1,10}(\.\d{1,2})?$/.test(s)) throw bad('Invalid amount'); const m = formatMoney(parseMoney(s)); if (!allowZero && Number(m) <= 0) throw bad('Amount must be above zero'); return m }
const nat = (v: unknown, max: number, dflt?: number): number => { if (v === undefined && dflt !== undefined) return dflt; if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > max) throw bad(); return v as number }
const id = (c: { req: { param: (k: string) => string } }) => { const x = c.req.param('id'); if (!isUuid(x)) throw notFound(); return x }
const patientOk = async (db: Db, clinicId: string, pid: unknown) => { if (typeof pid !== 'string' || !isUuid(pid) || !(await db.rows('SELECT 1 FROM patient WHERE id = $1 AND clinic_id = $2', [pid, clinicId])).length) throw notFound() }
const range = (q: Record<string, string>) => { const from = day(q.from)!, to = day(q.to)!; if (to < from || (Date.parse(to) - Date.parse(from)) / 864e5 > 400) throw bad('from/to must be a range of at most 400 days'); return { from, to } }

type KeyOpts = { table: string; cols: string; key: string; dir: 'ASC' | 'DESC'; where?: string; args?: unknown[]; cast: 'date' | 'text' | 'timestamptz'; limit?: [number, number] }
/** Keyset page over (key, id). $1 is always the clinic; extra filters add their own args after it. */
async function keyset(c: { get: (k: 'db') => Db; req: { query: () => Record<string, string> } }, clinicId: string, o: KeyOpts) {
  const q = c.req.query(), limit = parseLimit(q.limit, ...(o.limit ?? [25, 100])); if (limit === null) throw bad('Invalid limit'); const cur = decodeCursor(q.cursor)
  if (cur === null || (cur && (!isUuid(cur[1]) || (o.cast !== 'text' && Number.isNaN(Date.parse(cur[0])))))) throw bad('Invalid cursor')
  const args: unknown[] = [clinicId, ...(o.args ?? [])]; let w = o.where ? ` AND ${o.where}` : ''
  if (cur) { args.push(cur[0], cur[1]); w += ` AND (${o.key}, id) ${o.dir === 'ASC' ? '>' : '<'} ($${args.length - 1}::${o.cast}, $${args.length}::uuid)` }
  args.push(limit + 1)
  const rows = await c.get('db').rows(`SELECT ${o.cols}, ${o.key} AS k FROM ${o.table} WHERE clinic_id = $1${w} ORDER BY ${o.key} ${o.dir}, id ${o.dir} LIMIT $${args.length}`, args)
  return page(rows, limit, (x) => encodeCursor(String(x.k), String(x.id)))
}
const one = (v: unknown) => (v === null ? undefined : v)

// ---------------- expenses ----------------
const EXP_CATS = ['rent', 'salaries', 'supplies', 'lab', 'equipment', 'utilities', 'taxes', 'other']
const cat = (v: unknown) => { if (v === undefined || v === null) return null; if (!EXP_CATS.includes(String(v))) throw bad('Invalid category'); return String(v) }
const expView = (x: Record<string, unknown>) => ({ id: x.id, day: x.day, label: x.label, amount: Number(x.amount), category: one(x.category) })
practiceRoutes.get('/practice/expenses', requires('practice.view'), async (c) => {
  const { from, to } = range(c.req.query()), r = await keyset(c, c.get('principal').clinicId, { table: 'expense', cols: 'id, day::text AS day, label, amount, category', key: 'day', dir: 'DESC', where: 'voided_at IS NULL AND day BETWEEN $2::date AND $3::date', args: [from, to], cast: 'date' })
  return c.json({ items: r.items.map(expView), nextCursor: r.nextCursor })
})
practiceRoutes.get('/practice/expenses/summary', requires('practice.view'), async (c) => {
  const { from, to } = range(c.req.query())
  const rows = await c.get('db').rows<{ category: string | null; total: string }>('SELECT COALESCE(category, \'other\') AS category, sum(amount)::text AS total FROM expense WHERE clinic_id = $1 AND voided_at IS NULL AND day BETWEEN $2::date AND $3::date GROUP BY 1 ORDER BY 1', [c.get('principal').clinicId, from, to])
  return c.json({ items: rows.map((r) => ({ category: r.category, total: Number(r.total) })), total: rows.reduce((s, r) => s + Number(r.total), 0) })
})
practiceRoutes.post('/practice/expenses', requires('practice.create'), async (c) => {
  const b = await body(c), p = c.get('principal'), i = newId()
  await c.get('db').run('INSERT INTO expense (id, clinic_id, day, label, amount, category, created_at, created_by) VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8)', [i, p.clinicId, day(b.day), str(b.label, 200, true), money(b.amount), cat(b.category), toDb(c.get('now')), p.staffId])
  return c.json({ id: i }, 201)
})
practiceRoutes.patch('/practice/expenses/:id', requires('practice.edit'), async (c) => {
  const b = await body(c), sets: string[] = [], args: unknown[] = [], set = (col: string, v: unknown, cast = '') => { args.push(v); sets.push(`${col} = $${args.length}${cast}`) }
  if (b.day !== undefined) set('day', day(b.day), '::date'); if (b.label !== undefined) set('label', str(b.label, 200, true)); if (b.amount !== undefined) set('amount', money(b.amount)); if (b.category !== undefined) set('category', cat(b.category))
  if (!sets.length) throw bad('nothing to update')
  if ((await c.get('db').run(`UPDATE expense SET ${sets.join(', ')} WHERE id = $${args.length + 1} AND clinic_id = $${args.length + 2} AND voided_at IS NULL`, [...args, id(c), c.get('principal').clinicId])) !== 1) throw notFound(); return c.body(null, 204)
})
practiceRoutes.post('/practice/expenses/:id/void', requires('practice.edit'), async (c) => {
  const b = await body(c)
  if ((await c.get('db').run('UPDATE expense SET voided_at = $1, void_reason = $2 WHERE id = $3 AND clinic_id = $4 AND voided_at IS NULL', [toDb(c.get('now')), str(b.reason, 500, true), id(c), c.get('principal').clinicId])) !== 1) throw notFound(); return c.body(null, 204)
})

// ---------------- stock: quantity changes only through the ledger ----------------
const stockView = (x: Record<string, unknown>) => ({ id: x.id, name: x.name, qty: x.qty, min: x.min_qty, unit: one(x.unit), expires: one(x.expires), supplier: one(x.supplier), photoFileId: x.photo_file_id ?? null })
const STOCK = 'id, name, qty, min_qty, unit, expires::text AS expires, supplier, photo_file_id'
practiceRoutes.get('/practice/stock', requires('practice.view'), async (c) => {
  const q = c.req.query(), where: string[] = ['archived_at IS NULL'], args: unknown[] = []
  if (q.low === 'true') where.push('qty <= min_qty')
  if (q.q) { if (q.q.length > 100) throw bad(); args.push(`%${q.q.replace(/[\\%_]/g, '\\$&')}%`); where.push(`name ILIKE $${args.length + 1}`) }
  const r = await keyset(c, c.get('principal').clinicId, { table: 'stock_item', cols: STOCK, key: 'name', dir: 'ASC', where: where.join(' AND '), args, cast: 'text' })
  return c.json({ items: r.items.map(stockView), nextCursor: r.nextCursor })
})
practiceRoutes.post('/practice/stock', requires('practice.create'), async (c) => {
  const b = await body(c), p = c.get('principal'), i = newId(), qty = nat(b.qty, 1_000_000, 0), now = c.get('now')
  await c.get('db').tx(async (db) => {
    const [n] = await db.rows<{ n: string }>('SELECT count(*) n FROM stock_item WHERE clinic_id = $1 AND archived_at IS NULL', [p.clinicId]); if (Number(n.n) >= 2000) throw new ApiError(409, 'limit', 'Too many stock items')
    await db.run('INSERT INTO stock_item (id, clinic_id, name, qty, min_qty, unit, expires, supplier) VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8)', [i, p.clinicId, str(b.name, 200, true), qty, nat(b.min, 1_000_000, 0), str(b.unit, 20), day(b.expires, false), str(b.supplier, 200)])
    if (qty > 0) await db.run("INSERT INTO stock_movement (id, clinic_id, item_id, day, kind, change, after, staff_id, at) VALUES ($1,$2,$3,$4::date,'opening',$5,$5,$6,$7)", [newId(), p.clinicId, i, today(now), qty, p.staffId, toDb(now)])
  })
  return c.json({ id: i }, 201)
})
practiceRoutes.patch('/practice/stock/:id', requires('practice.edit'), async (c) => {
  const b = await body(c); if (b.qty !== undefined) throw bad('Quantity changes through stock movements')
  const sets: string[] = [], args: unknown[] = [], set = (col: string, v: unknown, cast = '') => { args.push(v); sets.push(`${col} = $${args.length}${cast}`) }
  if (b.name !== undefined) set('name', str(b.name, 200, true)); if (b.min !== undefined) set('min_qty', nat(b.min, 1_000_000)); if (b.unit !== undefined) set('unit', str(b.unit, 20)); if (b.expires !== undefined) set('expires', day(b.expires, false), '::date'); if (b.supplier !== undefined) set('supplier', str(b.supplier, 200))
  if (!sets.length) throw bad('nothing to update')
  if ((await c.get('db').run(`UPDATE stock_item SET ${sets.join(', ')} WHERE id = $${args.length + 1} AND clinic_id = $${args.length + 2} AND archived_at IS NULL`, [...args, id(c), c.get('principal').clinicId])) !== 1) throw notFound(); return c.body(null, 204)
})
practiceRoutes.delete('/practice/stock/:id', requires('practice.edit'), async (c) => {
  if ((await c.get('db').run('UPDATE stock_item SET archived_at = $1 WHERE id = $2 AND clinic_id = $3 AND archived_at IS NULL', [toDb(c.get('now')), id(c), c.get('principal').clinicId])) !== 1) throw notFound(); return c.body(null, 204)
})
practiceRoutes.post('/practice/stock/:id/moves', requires('practice.create'), async (c) => {
  const b = await body(c), p = c.get('principal'), item = id(c), now = c.get('now'), kind = String(b.kind), reason = str(b.reason, 300), d = day(b.day, false) ?? today(now)
  if (!['in', 'out', 'waste', 'adjust'].includes(kind)) throw bad('Invalid kind')
  const amount = b.amount; if (!Number.isInteger(amount) || (amount as number) < 0 || (amount as number) > 1_000_000 || (kind !== 'adjust' && (amount as number) < 1)) throw new ApiError(422, 'amount', 'Invalid amount')
  if (kind === 'adjust' && !reason) throw new ApiError(422, 'reason', 'An adjustment needs a reason')
  const qty = await c.get('db').tx(async (db) => {
    const [it] = await db.rows<{ qty: number }>('SELECT qty FROM stock_item WHERE id = $1 AND clinic_id = $2 AND archived_at IS NULL FOR UPDATE', [item, p.clinicId]); if (!it) throw notFound()
    const a = amount as number, change = kind === 'in' ? a : kind === 'adjust' ? a - it.qty : -a
    if ((kind === 'out' || kind === 'waste') && a > it.qty) throw new ApiError(409, 'insufficient', 'Not enough in stock')
    if (change === 0) throw new ApiError(422, 'amount', 'Nothing would change')
    const after = it.qty + change
    await db.run('UPDATE stock_item SET qty = $1 WHERE id = $2', [after, item])
    await db.run('INSERT INTO stock_movement (id, clinic_id, item_id, day, kind, change, after, reason, staff_id, at) VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10)', [newId(), p.clinicId, item, d, kind, change, after, reason, p.staffId, toDb(now)])
    return after
  })
  return c.json({ qty })
})
practiceRoutes.get('/practice/stock/:id/moves', requires('practice.view'), async (c) => {
  const p = c.get('principal'), item = id(c); if (!(await c.get('db').rows('SELECT 1 FROM stock_item WHERE id = $1 AND clinic_id = $2', [item, p.clinicId])).length) throw notFound()
  const r = await keyset(c, p.clinicId, { table: 'stock_movement', cols: 'id, day::text AS day, kind, change, after, reason, staff_id', key: 'at', dir: 'DESC', where: 'item_id = $2', args: [item], cast: 'timestamptz' })
  return c.json({ items: r.items.map((x) => ({ id: x.id, day: x.day, kind: x.kind, change: x.change, after: x.after, reason: one(x.reason), by: one(x.staff_id) })), nextCursor: r.nextCursor })
})

// ---------------- lab orders ----------------
const LAB = 'id, patient_id, work, lab, due::text AS due, status, tooth, shade, cost'
const labView = (x: Record<string, unknown>) => ({ id: x.id, patientId: x.patient_id, work: x.work, lab: x.lab, due: x.due, status: x.status, tooth: one(x.tooth), shade: one(x.shade), cost: x.cost === null ? undefined : Number(x.cost) })
const tooth = (v: unknown) => { const t = str(v, 2); if (t && !/^[1-8][1-8]$/.test(t)) throw bad('Invalid tooth'); return t }
practiceRoutes.get('/practice/lab', requires('practice.view'), async (c) => {
  const q = c.req.query(), where: string[] = [], args: unknown[] = []
  if (q.open === 'true') where.push("status IN ('sent','ready','remake')")
  if (q.status) { if (!['sent', 'ready', 'fitted', 'remake', 'cancelled'].includes(q.status)) throw bad('Invalid status'); args.push(q.status); where.push(`status = $${args.length + 1}`) }
  if (q.patientId) { if (!isUuid(q.patientId)) throw bad(); args.push(q.patientId); where.push(`patient_id = $${args.length + 1}`) }
  const r = await keyset(c, c.get('principal').clinicId, { table: 'lab_order', cols: LAB, key: 'due', dir: 'ASC', where: where.join(' AND ') || undefined, args, cast: 'date' })
  return c.json({ items: r.items.map(labView), nextCursor: r.nextCursor })
})
practiceRoutes.post('/practice/lab', requires('practice.create'), async (c) => {
  const b = await body(c), p = c.get('principal'), i = newId(), now = c.get('now')
  await c.get('db').tx(async (db) => {
    await patientOk(db, p.clinicId, b.patientId)
    await db.run('INSERT INTO lab_order (id, clinic_id, patient_id, work, lab, due, tooth, shade, cost, created_at) VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10)', [i, p.clinicId, b.patientId, str(b.work, 200, true), str(b.lab, 200, true), day(b.due), tooth(b.tooth), str(b.shade, 20), b.cost === undefined || b.cost === null ? null : money(b.cost, true), toDb(now)])
    await db.run("INSERT INTO lab_event (id, clinic_id, order_id, day, status, staff_id, at) VALUES ($1,$2,$3,$4::date,'sent',$5,$6)", [newId(), p.clinicId, i, today(now), p.staffId, toDb(now)])
  })
  return c.json({ id: i }, 201)
})
practiceRoutes.get('/practice/lab/:id', requires('practice.view'), async (c) => {
  const p = c.get('principal'), [o] = await c.get('db').rows(`SELECT ${LAB} FROM lab_order WHERE id = $1 AND clinic_id = $2`, [id(c), p.clinicId]); if (!o) throw notFound()
  const h = await c.get('db').rows('SELECT day::text AS day, status, staff_id, note FROM lab_event WHERE order_id = $1 ORDER BY at, id LIMIT 100', [o.id])
  return c.json({ ...labView(o), history: h.map((e) => ({ day: e.day, status: e.status, by: one(e.staff_id), note: one(e.note) })) })
})
// Fitted and cancelled orders are closed. Sending work back (remake) or dropping it (cancelled) must say why.
practiceRoutes.post('/practice/lab/:id/status', requires('practice.edit'), async (c) => {
  const b = await body(c), p = c.get('principal'), st = String(b.status), note = str(b.note, 500), now = c.get('now'), d = day(b.day, false) ?? today(now)
  if (!['sent', 'ready', 'fitted', 'remake', 'cancelled'].includes(st)) throw bad('Invalid status'); if ((st === 'remake' || st === 'cancelled') && !note) throw new ApiError(422, 'note', 'A reason is required')
  await c.get('db').tx(async (db) => {
    const [o] = await db.rows<{ status: string }>('SELECT status FROM lab_order WHERE id = $1 AND clinic_id = $2 FOR UPDATE', [id(c), p.clinicId]); if (!o) throw notFound()
    if (o.status === 'fitted' || o.status === 'cancelled') throw new ApiError(409, 'closed', 'This order is closed'); if (o.status === st) throw new ApiError(409, 'same', 'Already in that status')
    await db.run('UPDATE lab_order SET status = $1 WHERE id = $2', [st, id(c)])
    await db.run('INSERT INTO lab_event (id, clinic_id, order_id, day, status, staff_id, note, at) VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8)', [newId(), p.clinicId, id(c), d, st, p.staffId, note, toDb(now)])
  })
  return c.body(null, 204)
})

// ---------------- tasks ----------------
practiceRoutes.get('/tasks', requires('tasks.view'), async (c) => {
  const q = c.req.query(), r = await keyset(c, c.get('principal').clinicId, { table: 'task', cols: 'id, text, done', key: 'created_at', dir: 'ASC', where: q.done === 'false' ? 'NOT done' : q.done === 'true' ? 'done' : undefined, cast: 'timestamptz' })
  return c.json({ items: r.items.map((x) => ({ id: x.id, text: x.text, done: x.done })), nextCursor: r.nextCursor })
})
practiceRoutes.post('/tasks', requires('tasks.create'), async (c) => {
  const b = await body(c), p = c.get('principal'), i = newId()
  const [n] = await c.get('db').rows<{ n: string }>('SELECT count(*) n FROM task WHERE clinic_id = $1 AND NOT done', [p.clinicId]); if (Number(n.n) >= 1000) throw new ApiError(409, 'limit', 'Too many open tasks')
  await c.get('db').run('INSERT INTO task (id, clinic_id, text, created_at, created_by) VALUES ($1,$2,$3,$4,$5)', [i, p.clinicId, str(b.text, 500, true), toDb(c.get('now')), p.staffId]); return c.json({ id: i }, 201)
})
practiceRoutes.patch('/tasks/:id', requires('tasks.edit'), async (c) => {
  const b = await body(c), sets: string[] = [], args: unknown[] = []
  if (b.text !== undefined) { args.push(str(b.text, 500, true)); sets.push(`text = $${args.length}`) }
  if (b.done !== undefined) { if (typeof b.done !== 'boolean') throw bad(); args.push(b.done); sets.push(`done = $${args.length}`) }
  if (!sets.length) throw bad('nothing to update')
  if ((await c.get('db').run(`UPDATE task SET ${sets.join(', ')} WHERE id = $${args.length + 1} AND clinic_id = $${args.length + 2}`, [...args, id(c), c.get('principal').clinicId])) !== 1) throw notFound(); return c.body(null, 204)
})
practiceRoutes.delete('/tasks/:id', requires('tasks.edit'), async (c) => {
  if ((await c.get('db').run('DELETE FROM task WHERE id = $1 AND clinic_id = $2', [id(c), c.get('principal').clinicId])) !== 1) throw notFound(); return c.body(null, 204)
})

// ---------------- implants and sterilization (traceability records: written once) ----------------
practiceRoutes.get('/practice/implants', requires('practice.view'), async (c) => {
  const q = c.req.query(), where: string[] = [], args: unknown[] = []
  if (q.lot) { args.push(q.lot.slice(0, 60)); where.push(`lot = $${args.length + 1}`) }
  if (q.patientId) { if (!isUuid(q.patientId)) throw bad(); args.push(q.patientId); where.push(`patient_id = $${args.length + 1}`) }
  const r = await keyset(c, c.get('principal').clinicId, { table: 'implant_record', cols: 'id, patient_id, tooth, brand, lot, day::text AS day', key: 'created_at', dir: 'DESC', where: where.join(' AND ') || undefined, args, cast: 'timestamptz' })
  return c.json({ items: r.items.map((x) => ({ id: x.id, patientId: x.patient_id, tooth: x.tooth, brand: x.brand, lot: x.lot, day: x.day })), nextCursor: r.nextCursor })
})
practiceRoutes.post('/practice/implants', requires('practice.create'), async (c) => {
  const b = await body(c), p = c.get('principal'), i = newId(), t = tooth(b.tooth); if (!t) throw bad('tooth is required')
  await c.get('db').tx(async (db) => { await patientOk(db, p.clinicId, b.patientId); await db.run('INSERT INTO implant_record (id, clinic_id, patient_id, tooth, brand, lot, day, created_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9)', [i, p.clinicId, b.patientId, t, str(b.brand, 100, true), str(b.lot, 60, true), day(b.day), toDb(c.get('now')), p.staffId]) })
  return c.json({ id: i }, 201)
})
practiceRoutes.get('/practice/sterilization', requires('practice.view'), async (c) => {
  const r = await keyset(c, c.get('principal').clinicId, { table: 'sterilization_cycle', cols: 'id, day::text AS day, device, lot, operator', key: 'day', dir: 'DESC', cast: 'date' })
  return c.json({ items: r.items.map((x) => ({ id: x.id, day: x.day, device: x.device, lot: x.lot, operator: x.operator })), nextCursor: r.nextCursor })
})
practiceRoutes.post('/practice/sterilization', requires('practice.create'), async (c) => {
  const b = await body(c), p = c.get('principal'), i = newId()
  await c.get('db').run('INSERT INTO sterilization_cycle (id, clinic_id, day, device, lot, operator, created_at) VALUES ($1,$2,$3::date,$4,$5,$6,$7)', [i, p.clinicId, day(b.day), str(b.device, 100, true), str(b.lot, 60, true), str(b.operator, 100, true), toDb(c.get('now'))]); return c.json({ id: i }, 201)
})

// ---------------- equipment ----------------
const EQ = 'id, name, serial, location, every_months, last_service::text AS last_service'
const eqView = (x: Record<string, unknown>) => ({ id: x.id, name: x.name, serial: one(x.serial), location: one(x.location), everyMonths: one(x.every_months), lastService: one(x.last_service) })
const months = (v: unknown) => { if (v === undefined || v === null) return null; if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 120) throw bad('everyMonths must be 1-120'); return v as number }
practiceRoutes.get('/practice/equipment', requires('practice.view'), async (c) => {
  const r = await keyset(c, c.get('principal').clinicId, { table: 'equipment', cols: EQ, key: 'name', dir: 'ASC', where: 'archived_at IS NULL', cast: 'text' })
  return c.json({ items: r.items.map(eqView), nextCursor: r.nextCursor })
})
practiceRoutes.post('/practice/equipment', requires('practice.create'), async (c) => {
  const b = await body(c), p = c.get('principal'), i = newId()
  await c.get('db').run('INSERT INTO equipment (id, clinic_id, name, serial, location, every_months, last_service) VALUES ($1,$2,$3,$4,$5,$6,$7::date)', [i, p.clinicId, str(b.name, 200, true), str(b.serial, 100), str(b.location, 100), months(b.everyMonths), day(b.lastService, false)]); return c.json({ id: i }, 201)
})
practiceRoutes.patch('/practice/equipment/:id', requires('practice.edit'), async (c) => {
  const b = await body(c), sets: string[] = [], args: unknown[] = [], set = (col: string, v: unknown) => { args.push(v); sets.push(`${col} = $${args.length}`) }
  if (b.name !== undefined) set('name', str(b.name, 200, true)); if (b.serial !== undefined) set('serial', str(b.serial, 100)); if (b.location !== undefined) set('location', str(b.location, 100)); if (b.everyMonths !== undefined) set('every_months', months(b.everyMonths))
  if (!sets.length) throw bad('nothing to update')
  if ((await c.get('db').run(`UPDATE equipment SET ${sets.join(', ')} WHERE id = $${args.length + 1} AND clinic_id = $${args.length + 2} AND archived_at IS NULL`, [...args, id(c), c.get('principal').clinicId])) !== 1) throw notFound(); return c.body(null, 204)
})
practiceRoutes.delete('/practice/equipment/:id', requires('practice.edit'), async (c) => {
  if ((await c.get('db').run('UPDATE equipment SET archived_at = $1 WHERE id = $2 AND clinic_id = $3 AND archived_at IS NULL', [toDb(c.get('now')), id(c), c.get('principal').clinicId])) !== 1) throw notFound(); return c.body(null, 204)
})
practiceRoutes.post('/practice/equipment/:id/services', requires('practice.create'), async (c) => {
  const b = await body(c), p = c.get('principal'), d = day(b.day)!, i = newId()
  await c.get('db').tx(async (db) => {
    if (!(await db.rows('SELECT 1 FROM equipment WHERE id = $1 AND clinic_id = $2 AND archived_at IS NULL FOR UPDATE', [id(c), p.clinicId])).length) throw notFound()
    await db.run('INSERT INTO equipment_service (id, clinic_id, equipment_id, day, note, at) VALUES ($1,$2,$3,$4::date,$5,$6)', [i, p.clinicId, id(c), d, str(b.note, 500), toDb(c.get('now'))])
    await db.run('UPDATE equipment SET last_service = GREATEST(COALESCE(last_service, $1::date), $1::date) WHERE id = $2', [d, id(c)])
  })
  return c.json({ id: i }, 201)
})
practiceRoutes.get('/practice/equipment/:id/services', requires('practice.view'), async (c) => {
  const p = c.get('principal'); if (!(await c.get('db').rows('SELECT 1 FROM equipment WHERE id = $1 AND clinic_id = $2', [id(c), p.clinicId])).length) throw notFound()
  const r = await keyset(c, p.clinicId, { table: 'equipment_service', cols: 'id, day::text AS day, note', key: 'day', dir: 'DESC', where: 'equipment_id = $2', args: [id(c)], cast: 'date' })
  return c.json({ items: r.items.map((x) => ({ id: x.id, day: x.day, note: one(x.note) })), nextCursor: r.nextCursor })
})
