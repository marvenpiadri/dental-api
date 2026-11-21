import { Hono } from 'hono'
import { ApiError, fail } from '../http/errors'
import { authenticate, requires } from '../http/middleware'
import type { AppEnv } from '../http/context'
import type { Db } from '../db/client'
import { decodeCursor, encodeCursor, page, parseLimit } from '../lib/pagination'
import { isUuid, newId } from '../lib/ids'
import { toDb } from '../lib/time'

/** The clinic's own medication and allergy lists (nothing is built in) and each patient's allergy and medication records. */
export const libraryRoutes = new Hono<AppEnv>()
libraryRoutes.use('*', authenticate)
libraryRoutes.onError((e, c) => { if (e instanceof ApiError) return fail(c, e); throw e })
const bad = (m = 'Invalid request') => new ApiError(400, 'bad_request', m)
const notFound = () => new ApiError(404, 'not_found', 'Not found')
const body = async (c: { req: { json: () => Promise<unknown> } }) => { const b = await c.req.json().catch(() => null); if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad(); return b as Record<string, unknown> }
const str = (v: unknown, max: number, required = false): string | null => { if (v === undefined || v === null || v === '') { if (required) throw bad(); return null } if (typeof v !== 'string' || v.length > max) throw bad(); const t = v.trim(); if (!t && required) throw bad(); return t || null }
const day = (v: unknown): string | null => { if (v === undefined || v === null || v === '') return null; if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(v) || new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) !== v) throw bad('Dates must be YYYY-MM-DD'); return v }
const uid = (v: unknown, required = false) => { const t = str(v, 64, required); if (t && !isUuid(t)) throw bad(); return t }
const rid = (c: { req: { param: (k: string) => string } }) => { const x = c.req.param('id'); if (!isUuid(x)) throw notFound(); return x }
const patientOk = async (db: Db, clinicId: string, id: string) => { if (!isUuid(id) || !(await db.rows('SELECT 1 FROM patient WHERE id = $1 AND clinic_id = $2', [id, clinicId])).length) throw notFound() }
const one = (v: unknown) => (v === null ? undefined : v)
const bool = (v: unknown) => { if (typeof v !== 'boolean') throw bad(); return v }

/** Name-ordered keyset page. $1 clinic; `extra` is an optional filter with its own args after it. */
async function byName(c: { get: (k: 'db') => Db; req: { query: () => Record<string, string> } }, table: string, cols: string, clinicId: string, extra = '', args: unknown[] = []) {
  const q = c.req.query(), limit = parseLimit(q.limit); if (limit === null) throw bad('limit must be 1-100')
  const cur = decodeCursor(q.cursor); if (cur === null || (cur && !isUuid(cur[1]))) throw bad('Invalid cursor')
  const a: unknown[] = [clinicId, ...args]; let w = extra ? ` AND ${extra}` : ''
  if (q.hidden !== 'true') w += ' AND NOT hidden'
  if (q.q) { if (q.q.length > 100) throw bad(); a.push(`%${q.q.replace(/[\\%_]/g, '\\$&')}%`); w += ` AND name ILIKE $${a.length}` }
  if (cur) { a.push(cur[0], cur[1]); w += ` AND (name, id) > ($${a.length - 1}, $${a.length}::uuid)` }
  a.push(limit + 1)
  const rows = await c.get('db').rows(`SELECT ${cols} FROM ${table} WHERE clinic_id = $1${w} ORDER BY name, id LIMIT $${a.length}`, a)
  return page(rows, limit, (x) => encodeCursor(String(x.name), String(x.id)))
}
const conds = (v: unknown) => { if (v === undefined) return []; if (!Array.isArray(v) || v.length > 30 || v.some((x) => typeof x !== 'string' || x.length > 60)) throw bad(); return v as string[] }

// ---------------- medication master list ----------------
const medView = (x: Record<string, unknown>) => ({ id: x.id, kind: x.kind, name: x.name, genericId: one(x.generic_id), notes: one(x.notes), reviewConditions: x.review_conditions, hidden: x.hidden || undefined, externalId: one(x.external_id) })
const MED = 'id, kind, name, generic_id, notes, review_conditions, hidden, external_id'
libraryRoutes.get('/library/medications', requires('clinical.view'), async (c) => {
  const r = await byName(c, 'lib_medication', MED, c.get('principal').clinicId); return c.json({ items: r.items.map(medView), nextCursor: r.nextCursor })
})
libraryRoutes.post('/library/medications', requires('clinical.edit'), async (c) => {
  const b = await body(c), p = c.get('principal'), i = newId(); if (b.kind !== 'generic' && b.kind !== 'brand') throw bad('kind must be generic or brand')
  const generic = uid(b.genericId); if ((b.kind === 'brand') !== !!generic) throw bad('A brand needs a genericId; a generic cannot have one')
  await c.get('db').tx(async (db) => {
    if (generic && !(await db.rows("SELECT 1 FROM lib_medication WHERE id = $1 AND clinic_id = $2 AND kind = 'generic'", [generic, p.clinicId])).length) throw bad('Unknown generic')
    const [n] = await db.rows<{ n: string }>('SELECT count(*) n FROM lib_medication WHERE clinic_id = $1', [p.clinicId]); if (Number(n.n) >= 5000) throw new ApiError(409, 'limit', 'The medication list is full')
    await db.run('INSERT INTO lib_medication (id, clinic_id, kind, name, generic_id, notes, review_conditions, external_id) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)', [i, p.clinicId, b.kind, str(b.name, 200, true), generic, b.kind === 'generic' ? str(b.notes, 2000) : null, JSON.stringify(conds(b.reviewConditions)), str(b.externalId, 100)])
  })
  return c.json({ id: i }, 201)
})
libraryRoutes.patch('/library/medications/:id', requires('clinical.edit'), async (c) => {
  const b = await body(c), sets: string[] = [], args: unknown[] = [], set = (col: string, v: unknown, cast = '') => { args.push(v); sets.push(`${col} = $${args.length}${cast}`) }
  if (b.kind !== undefined || b.genericId !== undefined) throw bad('kind and genericId cannot change')
  if (b.name !== undefined) set('name', str(b.name, 200, true)); if (b.notes !== undefined) set('notes', str(b.notes, 2000)); if (b.reviewConditions !== undefined) set('review_conditions', JSON.stringify(conds(b.reviewConditions)), '::jsonb'); if (b.hidden !== undefined) set('hidden', bool(b.hidden)); if (b.externalId !== undefined) set('external_id', str(b.externalId, 100))
  if (!sets.length) throw bad('nothing to update')
  if ((await c.get('db').run(`UPDATE lib_medication SET ${sets.join(', ')} WHERE id = $${args.length + 1} AND clinic_id = $${args.length + 2} ${b.notes !== undefined ? "AND kind = 'generic'" : ''}`, [...args, rid(c), c.get('principal').clinicId])) !== 1) throw notFound(); return c.body(null, 204)
})

// ---------------- allergy master list ----------------
const defView = (x: Record<string, unknown>) => ({ id: x.id, name: x.name, medicationId: one(x.medication_id), externalId: one(x.external_id), hidden: x.hidden || undefined })
libraryRoutes.get('/library/allergies', requires('clinical.view'), async (c) => {
  const r = await byName(c, 'allergy_def', 'id, name, medication_id, external_id, hidden', c.get('principal').clinicId); return c.json({ items: r.items.map(defView), nextCursor: r.nextCursor })
})
libraryRoutes.post('/library/allergies', requires('clinical.edit'), async (c) => {
  const b = await body(c), p = c.get('principal'), i = newId(), med = uid(b.medicationId)
  await c.get('db').tx(async (db) => {
    if (med && !(await db.rows('SELECT 1 FROM lib_medication WHERE id = $1 AND clinic_id = $2', [med, p.clinicId])).length) throw bad('Unknown medication')
    const [n] = await db.rows<{ n: string }>('SELECT count(*) n FROM allergy_def WHERE clinic_id = $1', [p.clinicId]); if (Number(n.n) >= 2000) throw new ApiError(409, 'limit', 'The allergy list is full')
    await db.run('INSERT INTO allergy_def (id, clinic_id, name, medication_id, external_id) VALUES ($1,$2,$3,$4,$5)', [i, p.clinicId, str(b.name, 200, true), med, str(b.externalId, 100)])
  })
  return c.json({ id: i }, 201)
})
libraryRoutes.patch('/library/allergies/:id', requires('clinical.edit'), async (c) => {
  const b = await body(c), sets: string[] = [], args: unknown[] = [], set = (col: string, v: unknown) => { args.push(v); sets.push(`${col} = $${args.length}`) }
  if (b.name !== undefined) set('name', str(b.name, 200, true)); if (b.hidden !== undefined) set('hidden', bool(b.hidden)); if (b.externalId !== undefined) set('external_id', str(b.externalId, 100))
  if (!sets.length) throw bad('nothing to update')
  if ((await c.get('db').run(`UPDATE allergy_def SET ${sets.join(', ')} WHERE id = $${args.length + 1} AND clinic_id = $${args.length + 2}`, [...args, rid(c), c.get('principal').clinicId])) !== 1) throw notFound(); return c.body(null, 204)
})

// ---------------- a patient's allergies and medications, each with a small audit history ----------------
const event = (db: Db, clinicId: string, patientId: string, recordId: string, kind: 'allergy' | 'medication', what: string, note: string | null, now: number, staffId: string | null) =>
  db.run('INSERT INTO patient_record_event (id, clinic_id, patient_id, record_id, kind, what, note, at, staff_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [newId(), clinicId, patientId, recordId, kind, what, note, toDb(now), staffId])
const HISTORY = "COALESCE((SELECT json_agg(json_build_object('at', e.at, 'what', e.what, 'note', e.note) ORDER BY e.at, e.id) FROM (SELECT * FROM patient_record_event WHERE record_id = r.id ORDER BY at, id LIMIT 30) e), '[]'::json) AS history"
const alView = (x: Record<string, unknown>) => ({ id: x.id, allergyId: x.allergy_id, label: x.label, reaction: one(x.reaction), reactionDate: one(x.reaction_date), active: x.active, createdAt: x.created_at, removedAt: one(x.removed_at), legacyText: one(x.legacy_text), history: x.history })
libraryRoutes.get('/patients/:id/allergies', requires('clinical.view'), async (c) => {
  const p = c.get('principal'), pid = c.req.param('id'); await patientOk(c.get('db'), p.clinicId, pid)
  const rows = await c.get('db').rows(`SELECT r.id, r.allergy_id, r.label, r.reaction, r.reaction_date::text AS reaction_date, r.active, r.created_at, r.removed_at, r.legacy_text, ${HISTORY} FROM patient_allergy r WHERE r.clinic_id = $1 AND r.patient_id = $2 AND r.removed_at IS NULL ORDER BY r.created_at, r.id LIMIT 100`, [p.clinicId, pid])
  return c.json({ items: rows.map(alView) })
})
libraryRoutes.post('/patients/:id/allergies', requires('clinical.create'), async (c) => {
  const p = c.get('principal'), b = await body(c), pid = c.req.param('id'), i = newId(), now = c.get('now'), allergyId = uid(b.allergyId, true)!
  await c.get('db').tx(async (db) => {
    await patientOk(db, p.clinicId, pid)
    const [d] = await db.rows<{ name: string }>('SELECT name FROM allergy_def WHERE id = $1 AND clinic_id = $2', [allergyId, p.clinicId]); if (!d) throw bad('Unknown allergy')
    if ((await db.rows('SELECT 1 FROM patient_allergy WHERE patient_id = $1 AND allergy_id = $2 AND removed_at IS NULL', [pid, allergyId])).length) throw new ApiError(409, 'duplicate', 'The patient already has this allergy')
    const [n] = await db.rows<{ n: string }>('SELECT count(*) n FROM patient_allergy WHERE patient_id = $1 AND removed_at IS NULL', [pid]); if (Number(n.n) >= 100) throw new ApiError(409, 'limit', 'Too many allergies')
    await db.run('INSERT INTO patient_allergy (id, clinic_id, patient_id, allergy_id, label, reaction, reaction_date, legacy_text, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9)', [i, p.clinicId, pid, allergyId, str(b.label, 200) ?? d.name, str(b.reaction, 500), day(b.reactionDate), str(b.legacyText, 500), toDb(now)])
    await event(db, p.clinicId, pid, i, 'allergy', 'added', null, now, p.staffId)
  })
  return c.json({ id: i }, 201)
})
libraryRoutes.patch('/patient-allergies/:id', requires('clinical.edit'), async (c) => {
  const p = c.get('principal'), b = await body(c), i = rid(c), sets: string[] = [], args: unknown[] = [], set = (col: string, v: unknown, cast = '') => { args.push(v); sets.push(`${col} = $${args.length}${cast}`) }
  if (b.reaction !== undefined) set('reaction', str(b.reaction, 500)); if (b.reactionDate !== undefined) set('reaction_date', day(b.reactionDate), '::date'); if (b.active !== undefined) set('active', bool(b.active))
  if (!sets.length) throw bad('nothing to update')
  await c.get('db').tx(async (db) => {
    const [r] = await db.rows<{ patient_id: string }>('SELECT patient_id FROM patient_allergy WHERE id = $1 AND clinic_id = $2 AND removed_at IS NULL FOR UPDATE', [i, p.clinicId]); if (!r) throw notFound()
    await db.run(`UPDATE patient_allergy SET ${sets.join(', ')} WHERE id = $${args.length + 1}`, [...args, i])
    await event(db, p.clinicId, r.patient_id, i, 'allergy', b.active === undefined ? 'updated' : b.active ? 'reactivated' : 'inactive', str(b.note, 500), c.get('now'), p.staffId)
  })
  return c.body(null, 204)
})
libraryRoutes.delete('/patient-allergies/:id', requires('clinical.edit'), async (c) => {
  const p = c.get('principal'), b = await c.req.json().catch(() => ({})) as Record<string, unknown>, i = rid(c)
  await c.get('db').tx(async (db) => {
    const [r] = await db.rows<{ patient_id: string }>('SELECT patient_id FROM patient_allergy WHERE id = $1 AND clinic_id = $2 AND removed_at IS NULL FOR UPDATE', [i, p.clinicId]); if (!r) throw notFound()
    await db.run('UPDATE patient_allergy SET removed_at = $1, active = false WHERE id = $2', [toDb(c.get('now')), i]); await event(db, p.clinicId, r.patient_id, i, 'allergy', 'removed', str(b.reason, 500), c.get('now'), p.staffId)
  })
  return c.body(null, 204)
})

const pmView = (x: Record<string, unknown>) => ({ id: x.id, medicationId: x.medication_id, label: x.label, notes: one(x.notes), start: one(x.start_day), stop: one(x.stop_day), active: x.active, source: one(x.source), prescriptionId: one(x.prescription_id), createdAt: x.created_at, removedAt: one(x.removed_at), legacyText: one(x.legacy_text), history: x.history })
libraryRoutes.get('/patients/:id/medications', requires('clinical.view'), async (c) => {
  const p = c.get('principal'), pid = c.req.param('id'); await patientOk(c.get('db'), p.clinicId, pid)
  const rows = await c.get('db').rows(`SELECT r.id, r.medication_id, r.label, r.notes, r.start_day::text AS start_day, r.stop_day::text AS stop_day, r.active, r.source, r.prescription_id, r.created_at, r.removed_at, r.legacy_text, ${HISTORY} FROM patient_medication r WHERE r.clinic_id = $1 AND r.patient_id = $2 AND r.removed_at IS NULL ORDER BY r.created_at, r.id LIMIT 100`, [p.clinicId, pid])
  return c.json({ items: rows.map(pmView) })
})
libraryRoutes.post('/patients/:id/medications', requires('clinical.create'), async (c) => {
  const p = c.get('principal'), b = await body(c), pid = c.req.param('id'), i = newId(), now = c.get('now'), medId = uid(b.medicationId, true)!, start = day(b.start), stop = day(b.stop)
  if (start && stop && stop < start) throw bad('stop is before start'); if (b.source !== undefined && !['manual', 'prescribed', 'reported'].includes(String(b.source))) throw bad('Invalid source')
  await c.get('db').tx(async (db) => {
    await patientOk(db, p.clinicId, pid)
    const [m] = await db.rows<{ name: string }>('SELECT name FROM lib_medication WHERE id = $1 AND clinic_id = $2', [medId, p.clinicId]); if (!m) throw bad('Unknown medication')
    const rx = uid(b.prescriptionId); if (rx && !(await db.rows('SELECT 1 FROM prescription WHERE id = $1 AND clinic_id = $2 AND patient_id = $3', [rx, p.clinicId, pid])).length) throw notFound()
    const [n] = await db.rows<{ n: string }>('SELECT count(*) n FROM patient_medication WHERE patient_id = $1 AND removed_at IS NULL', [pid]); if (Number(n.n) >= 100) throw new ApiError(409, 'limit', 'Too many medications')
    await db.run('INSERT INTO patient_medication (id, clinic_id, patient_id, medication_id, label, notes, start_day, stop_day, source, prescription_id, legacy_text, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10,$11,$12)', [i, p.clinicId, pid, medId, str(b.label, 200) ?? m.name, str(b.notes, 500), start, stop, b.source ?? 'manual', rx, str(b.legacyText, 500), toDb(now)])
    await event(db, p.clinicId, pid, i, 'medication', 'added', null, now, p.staffId)
  })
  return c.json({ id: i }, 201)
})
libraryRoutes.patch('/patient-medications/:id', requires('clinical.edit'), async (c) => {
  const p = c.get('principal'), b = await body(c), i = rid(c), sets: string[] = [], args: unknown[] = [], set = (col: string, v: unknown, cast = '') => { args.push(v); sets.push(`${col} = $${args.length}${cast}`) }
  if (b.notes !== undefined) set('notes', str(b.notes, 500)); if (b.start !== undefined) set('start_day', day(b.start), '::date'); if (b.stop !== undefined) set('stop_day', day(b.stop), '::date'); if (b.active !== undefined) set('active', bool(b.active))
  if (!sets.length) throw bad('nothing to update')
  await c.get('db').tx(async (db) => {
    const [r] = await db.rows<{ patient_id: string }>('SELECT patient_id FROM patient_medication WHERE id = $1 AND clinic_id = $2 AND removed_at IS NULL FOR UPDATE', [i, p.clinicId]); if (!r) throw notFound()
    await db.run(`UPDATE patient_medication SET ${sets.join(', ')} WHERE id = $${args.length + 1}`, [...args, i])
    await event(db, p.clinicId, r.patient_id, i, 'medication', b.active === undefined ? 'updated' : b.active ? 'reactivated' : 'stopped', str(b.note, 500), c.get('now'), p.staffId)
  })
  return c.body(null, 204)
})
libraryRoutes.delete('/patient-medications/:id', requires('clinical.edit'), async (c) => {
  const p = c.get('principal'), b = await c.req.json().catch(() => ({})) as Record<string, unknown>, i = rid(c)
  await c.get('db').tx(async (db) => {
    const [r] = await db.rows<{ patient_id: string }>('SELECT patient_id FROM patient_medication WHERE id = $1 AND clinic_id = $2 AND removed_at IS NULL FOR UPDATE', [i, p.clinicId]); if (!r) throw notFound()
    await db.run('UPDATE patient_medication SET removed_at = $1, active = false WHERE id = $2', [toDb(c.get('now')), i]); await event(db, p.clinicId, r.patient_id, i, 'medication', 'removed', str(b.reason, 500), c.get('now'), p.staffId)
  })
  return c.body(null, 204)
})
