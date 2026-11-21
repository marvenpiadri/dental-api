import { Hono } from 'hono'
import { ApiError, fail } from '../http/errors'
import { authenticate, requires } from '../http/middleware'
import type { AppEnv } from '../http/context'

/** Reports are aggregated in SQL, in the clinic's time zone and currency. Nothing here returns a patient's whole history. */
export const reportRoutes = new Hono<AppEnv>()
reportRoutes.use('*', authenticate)
reportRoutes.onError((e, c) => { if (e instanceof ApiError) return fail(c, e); throw e })
const bad = (m = 'Invalid request') => new ApiError(400, 'bad_request', m)
const day = (v: unknown) => { if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(v) || new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) !== v) throw bad('Dates must be YYYY-MM-DD'); return v }
const top = (v: string | undefined) => { if (v === undefined) return 5; if (!/^\d{1,2}$/.test(v) || Number(v) < 1 || Number(v) > 50) throw bad('top must be 1-50'); return Number(v) }
const num = (v: unknown) => Number(v ?? 0)
const clinic = async (c: { get: (k: 'db') => import('../db/client').Db }, id: string) => (await c.get('db').rows<{ timezone: string; currency: string }>('SELECT timezone, currency FROM clinic WHERE id = $1', [id]))[0]

// GET /reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive days in the clinic's zone, at most 400). The series is daily up to 62 days, monthly beyond.
reportRoutes.get('/reports/summary', requires('reports.view'), async (c) => {
  const q = c.req.query(), from = day(q.from), to = day(q.to), span = (Date.parse(to) - Date.parse(from)) / 864e5
  if (span < 0 || span > 400) throw bad('from/to must be a range of at most 400 days')
  const p = c.get('principal'), { timezone: tz, currency } = await clinic(c, p.clinicId), db = c.get('db'), monthly = span > 62
  const pay = `FROM payment WHERE clinic_id = $1 AND voided_at IS NULL AND currency = $4 AND (at AT TIME ZONE $2)::date BETWEEN $3::date AND $5::date`
  const [byMethod, series, charged, visits, fresh, dentists] = await Promise.all([
    db.rows<{ method: string; t: string }>(`SELECT method, sum(amount)::text t ${pay} GROUP BY method`, [p.clinicId, tz, from, currency, to]),
    db.rows<{ at: string; t: string }>(`SELECT to_char(date_trunc('${monthly ? 'month' : 'day'}', at AT TIME ZONE $2), 'YYYY-MM-DD') AS at, sum(amount)::text t ${pay} GROUP BY 1 ORDER BY 1`, [p.clinicId, tz, from, currency, to]),
    db.rows<{ t: string }>("SELECT COALESCE(sum(price), 0)::text t FROM treatment_item WHERE clinic_id = $1 AND status = 'done' AND currency = $4 AND done_date BETWEEN $2::date AND $3::date", [p.clinicId, from, to, currency]),
    db.rows<{ status: string; n: string }>("SELECT status, count(*) n FROM appointment WHERE clinic_id = $1 AND (start_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date AND status IN ('completed','no-show','cancelled') GROUP BY status", [p.clinicId, tz, from, to]),
    db.rows<{ n: string }>('SELECT count(*) n FROM patient WHERE clinic_id = $1 AND (created_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date', [p.clinicId, tz, from, to]),
    db.rows<{ id: string; name: string; n: string }>("SELECT d.id, d.name, count(a.id) n FROM dentist_profile d LEFT JOIN appointment a ON a.dentist_id = d.id AND a.clinic_id = d.clinic_id AND a.status = 'completed' AND (a.start_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date WHERE d.clinic_id = $1 AND d.archived_at IS NULL GROUP BY d.id, d.name ORDER BY n DESC, d.name, d.id LIMIT 100", [p.clinicId, tz, from, to]),
  ])
  const m = Object.fromEntries(['cash', 'card', 'transfer', 'cheque', 'other'].map((k) => [k, 0])) as Record<string, number>; for (const r of byMethod) m[r.method] = num(r.t)
  const count = (s: string) => num(visits.find((v) => v.status === s)?.n), completed = count('completed'), noShows = count('no-show')
  return c.json({ currency, timezone: tz, from, to, bucket: monthly ? 'month' : 'day', revenue: Object.values(m).reduce((a, b) => a + b, 0), charged: num(charged[0].t), byMethod: m, completed, noShows, cancelled: count('cancelled'),
    noShowRate: completed + noShows ? noShows / (completed + noShows) : null, newPatients: num(fresh[0].n), byDentist: dentists.map((d) => ({ dentistId: d.id, name: d.name, completed: num(d.n) })), series: series.map((s) => ({ at: s.at, amount: num(s.t) })) })
})

// What patients owe right now (billed minus received, exact in SQL), biggest first.
reportRoutes.get('/reports/receivables', requires('reports.view'), async (c) => {
  const p = c.get('principal'), n = top(c.req.query().top), { currency } = await clinic(c, p.clinicId)
  const rows = await c.get('db').rows<{ id: string; number: string; full_name: string; due: string; total: string; owing: string }>(
    `WITH b AS (SELECT patient_id, sum(total) v FROM invoice WHERE clinic_id = $1 AND currency = $2 GROUP BY 1),
          pa AS (SELECT patient_id, sum(amount) v FROM payment WHERE clinic_id = $1 AND currency = $2 AND voided_at IS NULL GROUP BY 1),
          rf AS (SELECT i.patient_id, sum(f.amount) v FROM refund f JOIN invoice i ON i.id = f.credit_note_id AND i.clinic_id = f.clinic_id WHERE f.clinic_id = $1 AND i.currency = $2 GROUP BY 1),
          d AS (SELECT p.id, p.number, p.full_name, COALESCE(b.v, 0) - (COALESCE(pa.v, 0) - COALESCE(rf.v, 0)) AS due FROM patient p LEFT JOIN b ON b.patient_id = p.id LEFT JOIN pa ON pa.patient_id = p.id LEFT JOIN rf ON rf.patient_id = p.id WHERE p.clinic_id = $1 AND p.archived_at IS NULL)
     SELECT id, number, full_name, due::text, (SELECT COALESCE(sum(due), 0) FROM d WHERE due > 0)::text total, (SELECT count(*) FROM d WHERE due > 0)::text owing FROM d WHERE d.due > 0 ORDER BY d.due DESC, d.full_name, d.id LIMIT $3`, [p.clinicId, currency, n])
  const [t] = rows.length ? [rows[0]] : [{ total: '0', owing: '0' }]
  return c.json({ currency, total: num(t.total), owing: num(t.owing), top: rows.map((r) => ({ patientId: r.id, number: r.number, fullName: r.full_name, due: num(r.due) })) })
})

// Standing invoices past their due day with money still owed, oldest due first.
reportRoutes.get('/reports/overdue', requires('reports.view'), async (c) => {
  const p = c.get('principal'), n = top(c.req.query().top), { timezone: tz, currency } = await clinic(c, p.clinicId)
  const base = `WITH o AS (SELECT i.id, i.patient_id, i.number, i.due_on, i.total - COALESCE((SELECT sum(amount) FROM payment WHERE invoice_id = i.id AND clinic_id = i.clinic_id AND voided_at IS NULL), 0) AS remaining
                FROM invoice i WHERE i.clinic_id = $1 AND i.kind = 'invoice' AND i.cancelled_at IS NULL AND i.currency = $2 AND i.due_on IS NOT NULL AND i.due_on < (now() AT TIME ZONE $3)::date)`
  const rows = await c.get('db').rows<{ patient_id: string; full_name: string; number: string; due_on: string; remaining: string; total: string; n: string }>(
    `${base}, w AS (SELECT o.*, p.full_name FROM o JOIN patient p ON p.id = o.patient_id AND p.archived_at IS NULL WHERE o.remaining > 0)
     SELECT patient_id, full_name, number, due_on::text, remaining::text, (SELECT COALESCE(sum(remaining), 0) FROM w)::text total, (SELECT count(*) FROM w)::text n FROM w ORDER BY w.due_on, w.number LIMIT $4`, [p.clinicId, currency, tz, n])
  return c.json({ currency, count: rows.length ? num(rows[0].n) : 0, total: rows.length ? num(rows[0].total) : 0, top: rows.map((r) => ({ patientId: r.patient_id, fullName: r.full_name, number: r.number, dueOn: r.due_on, remaining: num(r.remaining) })) })
})
