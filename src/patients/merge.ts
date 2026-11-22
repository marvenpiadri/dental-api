import { Hono } from 'hono'
import { ApiError, fail } from '../http/errors'
import { authenticate, requires } from '../http/middleware'
import type { AppEnv } from '../http/context'
import { ExclusionError, type Db } from '../db/client'
import { isUuid, newId } from '../lib/ids'
import { toDb } from '../lib/time'
import { norm } from './routes'

/** Duplicate detection and merge. A merge only moves what may legally move; clinical and billing records are immutable, so a file that has them is refused instead of rewritten. */
export const mergeRoutes = new Hono<AppEnv>()
mergeRoutes.use('*', authenticate)
mergeRoutes.onError((e, c) => { if (e instanceof ApiError) return fail(c, e); throw e })
const bad = (m = 'Invalid request') => new ApiError(400, 'bad_request', m)
const notFound = () => new ApiError(404, 'not_found', 'Not found')
const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '')
const CAND = 'id, number, full_name, phone, birth_date::text AS birth_date, similarity(search_name, $2) AS sim'
const view = (x: Record<string, unknown>) => ({ id: x.id, number: x.number, fullName: x.full_name, phone: x.phone ?? undefined, birthDate: x.birth_date ?? undefined, reason: x.reason })

// Same phone number, or a very similar name with the same (or unknown) birth date. Bounded to 10 and index-assisted.
async function candidates(db: Db, clinicId: string, name: string, phone: string | null, birth: string | null, excludeId: string | null) {
  const n = norm(name), ph = digits(phone)
  const rows = await db.rows(
    `SELECT ${CAND}, CASE WHEN $3 <> '' AND regexp_replace(COALESCE(phone,''), '\\D', '', 'g') = $3 THEN 'phone' ELSE 'name' END AS reason
     FROM patient WHERE clinic_id = $1 AND archived_at IS NULL AND ($4::uuid IS NULL OR id <> $4)
       AND (($3 <> '' AND length($3) >= 6 AND regexp_replace(COALESCE(phone,''), '\\D', '', 'g') = $3) OR (search_name % $2 AND similarity(search_name, $2) >= 0.6 AND ($5::date IS NULL OR birth_date IS NULL OR birth_date = $5::date)))
     ORDER BY (CASE WHEN $3 <> '' AND regexp_replace(COALESCE(phone,''), '\\D', '', 'g') = $3 THEN 0 ELSE 1 END), sim DESC, id LIMIT 10`, [clinicId, n, ph, excludeId, birth])
  return rows.map(view)
}
mergeRoutes.post('/duplicate-check', requires('patients.create'), async (c) => {
  const b = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!b || typeof b.fullName !== 'string' || !b.fullName.trim() || b.fullName.length > 200) throw bad('fullName is required')
  const phone = typeof b.phone === 'string' ? b.phone.slice(0, 40) : null, birth = typeof b.birthDate === 'string' && /^\d{4}-\d\d-\d\d$/.test(b.birthDate) ? b.birthDate : null
  return c.json({ items: await candidates(c.get('db'), c.get('principal').clinicId, b.fullName, phone, birth, null) })
})
mergeRoutes.get('/:id/duplicates', requires('patients.view'), async (c) => {
  const id = c.req.param('id'), p = c.get('principal'); if (!isUuid(id)) throw notFound()
  const [x] = await c.get('db').rows<{ full_name: string; phone: string | null; birth_date: string | null }>('SELECT full_name, phone, birth_date::text AS birth_date FROM patient WHERE id = $1 AND clinic_id = $2', [id, p.clinicId]); if (!x) throw notFound()
  return c.json({ items: await candidates(c.get('db'), p.clinicId, x.full_name, x.phone, x.birth_date, id) })
})

// Records that cannot move: they are immutable by design (clinical history, money, issued documents).
const BLOCKERS: [string, string][] = [
  ['invoices', 'SELECT 1 FROM invoice WHERE patient_id = $1 LIMIT 1'], ['payments', 'SELECT 1 FROM payment WHERE patient_id = $1 LIMIT 1'], ['chart', 'SELECT 1 FROM chart_head WHERE patient_id = $1 LIMIT 1'],
  ['exams', 'SELECT 1 FROM exam WHERE patient_id = $1 LIMIT 1'], ['prescriptions', 'SELECT 1 FROM prescription WHERE patient_id = $1 LIMIT 1'], ['files', "SELECT 1 FROM file WHERE patient_id = $1 AND status = 'ready' LIMIT 1"],
  ['letters', 'SELECT 1 FROM letter WHERE patient_id = $1 LIMIT 1'], ['visits', 'SELECT 1 FROM visit_note WHERE patient_id = $1 LIMIT 1'], ['quotes', 'SELECT 1 FROM plan_proposal WHERE patient_id = $1 LIMIT 1'],
  ['allergies', 'SELECT 1 FROM patient_allergy WHERE patient_id = $1 LIMIT 1'], ['medications', 'SELECT 1 FROM patient_medication WHERE patient_id = $1 LIMIT 1'], ['implants', 'SELECT 1 FROM implant_record WHERE patient_id = $1 LIMIT 1'],
  ['labOrders', 'SELECT 1 FROM lab_order WHERE patient_id = $1 LIMIT 1'], ['completedTreatments', "SELECT 1 FROM treatment_item WHERE patient_id = $1 AND status = 'done' LIMIT 1"],
]
const FILL: [string, string][] = [['email', 'email'], ['birth_date', 'birth_date'], ['sex', 'sex'], ['country', 'country'], ['city', 'city'], ['address', 'address'], ['emergency_name', 'emergency_name'], ['emergency_phone', 'emergency_phone'], ['language', 'language'], ['referral', 'referral'], ['whatsapp_consent', 'whatsapp_consent'], ['whatsapp_consent_at', 'whatsapp_consent_at']]

// POST /patients/:duplicateId/merge { intoId } — moves appointments, planned items, insurance and messages (medical history stays on the archived file, read-only); fills blanks; archives the duplicate.
mergeRoutes.post('/:id/merge', requires('patients.manage'), async (c) => {
  const p = c.get('principal'), drop = c.req.param('id'), b = await c.req.json().catch(() => null) as { intoId?: unknown } | null, keep = b?.intoId
  if (!isUuid(drop) || typeof keep !== 'string' || !isUuid(keep)) throw bad('intoId is required'); if (drop === keep) throw bad('Choose a different file to keep')
  const now = c.get('now')
  try {
    await c.get('db').tx(async (db) => {
      const [first, second] = drop < keep ? [drop, keep] : [keep, drop] // fixed lock order
      const locked = await db.rows<Record<string, unknown>>('SELECT * FROM patient WHERE id IN ($1, $2) AND clinic_id = $3 ORDER BY id FOR UPDATE', [first, second, p.clinicId])
      const k = locked.find((r) => r.id === keep), d = locked.find((r) => r.id === drop); if (!k || !d) throw notFound()
      if (k.archived_at || d.archived_at) throw new ApiError(409, 'archived', 'Both files must be active')
      const blocked: string[] = []; for (const [name, sql] of BLOCKERS) if ((await db.rows(sql, [drop])).length) blocked.push(name)
      if (blocked.length) throw new ApiError(409, 'merge_blocked', `This file has records that cannot be moved: ${blocked.join(', ')}`)
      await db.run('UPDATE appointment SET patient_id = $1 WHERE patient_id = $2 AND clinic_id = $3', [keep, drop, p.clinicId])
      await db.run("UPDATE treatment_item SET patient_id = $1 WHERE patient_id = $2 AND clinic_id = $3 AND status = 'planned'", [keep, drop, p.clinicId])
      await db.run('UPDATE patient_insurance SET patient_id = $1 WHERE patient_id = $2 AND clinic_id = $3', [keep, drop, p.clinicId])
      await db.run('UPDATE message SET patient_id = $1 WHERE patient_id = $2 AND clinic_id = $3', [keep, drop, p.clinicId])
      const fills = FILL.filter(([col]) => k[col] === null && d[col] !== null).map(([col]) => col)
      const alert = d.alert && d.alert !== k.alert ? [k.alert, d.alert].filter(Boolean).join(' · ').slice(0, 500) : k.alert
      const line = `Merged from ${d.number} (${d.full_name}, ${d.phone ?? '-'}) on ${new Date(now).toISOString().slice(0, 10)}.`
      const notes = [k.notes, d.notes, line].filter(Boolean).join('\n').slice(-2000)
      await db.run(`UPDATE patient SET alert = $1, notes = $2${fills.map((col, i) => `, ${col} = $${i + 5}`).join('')} WHERE id = $3 AND clinic_id = $4`, [alert, notes, keep, p.clinicId, ...fills.map((col) => d[col])])
      await db.run('UPDATE patient SET archived_at = $1, merged_into_id = $2, waiting_since = NULL WHERE id = $3 AND clinic_id = $4', [toDb(now), keep, drop, p.clinicId])
      await db.run('INSERT INTO audit_event (id, clinic_id, staff_id, action, target_type, target_id, detail, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [newId(), p.clinicId, p.staffId, 'patient.merged', 'patient', keep, JSON.stringify({ from: drop }), toDb(now)])
    })
  } catch (e) { if (e instanceof ExclusionError) throw new ApiError(409, 'merge_blocked', 'The two files have overlapping appointments; resolve them first'); throw e }
  return c.body(null, 204)
})
