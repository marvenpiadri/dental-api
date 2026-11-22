import { Hono } from 'hono'
import { ApiError, fail } from '../http/errors'
import { authenticate } from '../http/middleware'
import type { AppEnv } from '../http/context'
import type { Db } from '../db/client'
import type { Permission } from '../auth/permissions'
import { decodeCursor, encodeCursor, page, parseLimit } from '../lib/pagination'
import { isUuid, newId } from '../lib/ids'
import { toDb } from '../lib/time'
import { MAGIC, MAGIC_BYTES, PURPOSES, type Purpose } from './purposes'
import { reap } from './reap'

/**
 * Central file service. Flow for every module (patient documents, X-rays, avatars, product images, lab attachments…):
 *   1. POST /files            authorize + validate, store a `pending` row, return a short-lived URL
 *   2. browser PUTs the bytes straight to the private bucket (nothing large passes through the Worker)
 *   3. POST /files/:id/complete   the server checks size, type and magic bytes IN the bucket, then makes the file `ready` and attaches it
 *   4. GET  /files/:id/content    authorize, then redirect to a 60-second read URL
 * Nothing here is public: the bucket has no public URL and no key is guessable or carries patient data.
 */
const UPLOAD_TTL = 600, READ_TTL = 60, PENDING_PER_HOUR = 50
export const filesRoutes = new Hono<AppEnv>()
filesRoutes.use('*', authenticate)
filesRoutes.onError((e, c) => { if (e instanceof ApiError) return fail(c, e); throw e })
const bad = (m = 'Invalid request') => new ApiError(400, 'bad_request', m)
const notFound = () => new ApiError(404, 'not_found', 'Not found')
const forbidden = () => new ApiError(403, 'forbidden', 'Not allowed')
const cleanName = (s: unknown) => (typeof s === 'string' ? s : '').normalize('NFC').replace(/[\x00-\x1f\x7f/\\"]/g, '').trim().slice(0, 200)

type FileRow = { id: string; clinic_id: string; purpose: string; name: string; content_type: string; size: string; r2_key: string; status: string; patient_id: string | null; lab_order_id: string | null; subject_id: string | null; uploaded_by: string | null; created_at: string }
const COLS = 'id, clinic_id, purpose, name, content_type, size, r2_key, status, patient_id, lab_order_id, subject_id, uploaded_by, created_at'
const view = (r: FileRow) => ({ id: r.id, purpose: r.purpose, name: r.name, contentType: r.content_type, size: Number(r.size), patientId: r.patient_id, labOrderId: r.lab_order_id, subjectId: r.subject_id, createdAt: r.created_at })
const purposeOf = (name: string): Purpose => { const p = PURPOSES[name]; if (!p) throw bad('Unknown purpose'); return p }
const canView = (p: Purpose, perms: ReadonlySet<Permission>) => p.view.some((x) => perms.has(x))

async function load(db: Db, id: string, clinicId: string): Promise<FileRow> {
  if (!isUuid(id)) throw notFound()
  const [r] = await db.rows<FileRow>(`SELECT ${COLS} FROM file WHERE id = $1 AND clinic_id = $2`, [id, clinicId])
  if (!r) throw notFound()
  return r
}
/** Ready, not removed, and the caller may see this purpose. Same 404 for "not yours" and "does not exist". */
async function loadVisible(db: Db, id: string, clinicId: string, perms: ReadonlySet<Permission>): Promise<FileRow> {
  const r = await load(db, id, clinicId)
  if (!canView(purposeOf(r.purpose), perms)) throw forbidden()
  const [live] = await db.rows("SELECT 1 FROM file WHERE id = $1 AND status = 'ready' AND voided_at IS NULL", [id])
  if (!live) throw notFound()
  return r
}

// What the browser needs to know: allowed types, size caps, and whether to leave the pixels alone.
filesRoutes.get('/files/purposes', (c) => {
  const perms = c.get('principal').permissions
  return c.json(Object.fromEntries(Object.entries(PURPOSES).map(([k, p]) => [k, { types: p.types, maxBytes: p.max, lossless: p.lossless, canUpload: perms.has(p.create) }])))
})

filesRoutes.post('/files', async (c) => {
  const p = c.get('principal'), db = c.get('db')
  const b = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad()
  const purpose = purposeOf(String(b.purpose)), name = cleanName(b.name), type = String(b.contentType ?? '').toLowerCase(), size = b.size
  const patientId = b.patientId ?? null, labOrderId = b.labOrderId ?? null, subjectId = b.subjectId ?? null
  const own = purpose.owner?.selfStaff && subjectId === p.staffId
  if (!p.permissions.has(purpose.create) && !own) throw forbidden()
  if (!name) throw bad('name is required')
  if (!purpose.types.includes(type)) throw new ApiError(415, 'unsupported_type', 'This file type is not accepted here')
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) throw bad('size is required')
  if (size > purpose.max) throw new ApiError(413, 'too_large', 'File is too large')
  // The association must exist in THIS clinic; ids from the browser are never trusted.
  let patient: string | null = null, lab: string | null = null, subject: string | null = null
  if (purpose.attach === 'patient') {
    if (typeof patientId !== 'string' || !isUuid(patientId) || !(await db.rows('SELECT 1 FROM patient WHERE id = $1 AND clinic_id = $2', [patientId, p.clinicId])).length) throw notFound()
    patient = patientId
  } else if (purpose.attach === 'lab') {
    if (typeof labOrderId !== 'string' || !isUuid(labOrderId)) throw notFound()
    const [o] = await db.rows<{ patient_id: string }>('SELECT patient_id FROM lab_order WHERE id = $1 AND clinic_id = $2', [labOrderId, p.clinicId]); if (!o) throw notFound()
    lab = labOrderId; patient = o.patient_id
  } else {
    if (typeof subjectId !== 'string' || !isUuid(subjectId) || !(await db.rows(`SELECT 1 FROM ${purpose.owner!.table} WHERE id = $1 AND clinic_id = $2`, [subjectId, p.clinicId])).length) throw notFound()
    subject = subjectId
  }
  const [{ n }] = await db.rows<{ n: string }>("SELECT count(*) AS n FROM file WHERE uploaded_by = $1 AND status = 'pending' AND created_at > $2", [p.staffId, toDb(c.get('now') - 3_600_000)])
  if (Number(n) >= PENDING_PER_HOUR) throw new ApiError(429, 'too_many_uploads', 'Too many unfinished uploads. Try again later.')
  const id = newId(), key = `${p.clinicId}/${b.purpose}/${id}` // random ids only: no patient data in a key
  await db.run('INSERT INTO file (id, clinic_id, purpose, name, content_type, size, r2_key, status, patient_id, lab_order_id, subject_id, uploaded_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,\'pending\',$8,$9,$10,$11,$12)',
    [id, p.clinicId, b.purpose, name, type, size, key, patient, lab, subject, p.staffId, toDb(c.get('now'))])
  const url = await c.get('files').presignPut(key, type, UPLOAD_TTL)
  return c.json({ id, upload: { method: 'PUT', url, headers: { 'Content-Type': type }, expiresInSeconds: UPLOAD_TTL } }, 201)
})

filesRoutes.post('/files/:id/complete', async (c) => {
  const p = c.get('principal'), db = c.get('db'), store = c.get('files')
  const f = await load(db, c.req.param('id'), p.clinicId)
  if (f.uploaded_by !== p.staffId) throw notFound()
  if (f.status === 'ready') return c.json(view(f)) // a retry after a lost response
  const purpose = purposeOf(f.purpose)
  const discard = async () => { await reap(db, store, [f]) }
  const head = await store.head(f.r2_key)
  if (!head) throw new ApiError(409, 'not_uploaded', 'The file has not arrived yet')
  if (head.size !== Number(f.size) || (head.contentType ?? '').split(';')[0].trim().toLowerCase() !== f.content_type) { await discard(); throw new ApiError(422, 'upload_mismatch', 'The uploaded file does not match what was declared') }
  const bytes = await store.peek(f.r2_key, MAGIC_BYTES)
  if (!bytes || !MAGIC[f.content_type](bytes)) { await discard(); throw new ApiError(415, 'content_mismatch', 'The file content does not match its type') }
  let replaced: { id: string; r2_key: string } | null = null
  try {
    await db.tx(async (t) => {
      if (purpose.attach === 'owner') {
        const [o] = await t.rows<{ photo_file_id: string | null }>(`SELECT photo_file_id FROM ${purpose.owner!.table} WHERE id = $1 AND clinic_id = $2 FOR UPDATE`, [f.subject_id, p.clinicId])
        if (!o) throw notFound()
        if (o.photo_file_id) {
          const [old] = await t.rows<{ id: string; r2_key: string }>('SELECT id, r2_key FROM file WHERE id = $1 AND clinic_id = $2', [o.photo_file_id, p.clinicId])
          if (old) { replaced = old; await t.run("UPDATE file SET voided_at = $1, void_reason = 'replaced' WHERE id = $2 AND clinic_id = $3 AND voided_at IS NULL", [toDb(c.get('now')), old.id, p.clinicId]) }
        }
      }
      const at = toDb(c.get('now'))
      if ((await t.run("UPDATE file SET status = 'ready', ready_at = $1 WHERE id = $2 AND clinic_id = $3 AND status = 'pending'", [at, f.id, p.clinicId])) !== 1) throw new ApiError(409, 'conflict', 'Already completed')
      if (purpose.attach === 'owner') await t.run(`UPDATE ${purpose.owner!.table} SET photo_file_id = $1 WHERE id = $2 AND clinic_id = $3`, [f.id, f.subject_id, p.clinicId])
    })
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) return c.json(view(await load(db, f.id, p.clinicId))) // a parallel complete won
    if (e instanceof ApiError) await discard()
    throw e
  }
  if (replaced) await reap(db, store, [replaced])
  return c.json(view(await load(db, f.id, p.clinicId)))
})

filesRoutes.get('/files/:id', async (c) => c.json(view(await loadVisible(c.get('db'), c.req.param('id'), c.get('principal').clinicId, c.get('principal').permissions))))

// Authorize, then hand the browser a read URL that expires in a minute. Images show inline; everything else downloads.
filesRoutes.get('/files/:id/content', async (c) => {
  const f = await loadVisible(c.get('db'), c.req.param('id'), c.get('principal').clinicId, c.get('principal').permissions)
  const url = await c.get('files').presignGet(f.r2_key, { contentType: f.content_type, filename: f.name, inline: f.content_type.startsWith('image/') }, READ_TTL)
  return new Response(null, { status: 302, headers: { Location: url, 'Cache-Control': 'private, max-age=30', 'Referrer-Policy': 'no-referrer' } })
})

// Clinical files are never deleted: voiding hides them and keeps record and bytes (retention). Pictures and product images are removed for real.
filesRoutes.post('/files/:id/void', async (c) => {
  const p = c.get('principal'), f = await load(c.get('db'), c.req.param('id'), p.clinicId), purpose = purposeOf(f.purpose)
  if (!p.permissions.has(purpose.void)) throw forbidden()
  if (!purpose.retain) throw new ApiError(409, 'not_retained', 'Use DELETE for this kind of file')
  const b = await c.req.json().catch(() => null) as { reason?: unknown } | null
  if (!b || typeof b.reason !== 'string' || !b.reason.trim() || b.reason.length > 500) throw bad('A reason is required')
  const n = await c.get('db').run("UPDATE file SET voided_at = $1, void_reason = $2 WHERE id = $3 AND clinic_id = $4 AND voided_at IS NULL AND status = 'ready'", [toDb(c.get('now')), b.reason.trim(), f.id, p.clinicId])
  if (n !== 1) throw notFound(); return c.body(null, 204)
})
filesRoutes.delete('/files/:id', async (c) => {
  const p = c.get('principal'), db = c.get('db'), f = await load(db, c.req.param('id'), p.clinicId), purpose = purposeOf(f.purpose)
  const own = purpose.owner?.selfStaff && f.subject_id === p.staffId
  if (!p.permissions.has(purpose.void) && !own) throw forbidden()
  if (purpose.retain) throw new ApiError(409, 'retained', 'Clinical files cannot be deleted; void them instead')
  const done = await db.tx(async (t) => {
    await t.run(`UPDATE ${purpose.owner!.table} SET photo_file_id = NULL WHERE id = $1 AND clinic_id = $2 AND photo_file_id = $3`, [f.subject_id, p.clinicId, f.id])
    return t.run("UPDATE file SET voided_at = $1, void_reason = 'removed' WHERE id = $2 AND clinic_id = $3 AND voided_at IS NULL", [toDb(c.get('now')), f.id, p.clinicId])
  })
  if (done !== 1) throw notFound()
  await reap(db, c.get('files'), [f]) // best effort; the scheduled purge retries
  return c.body(null, 204)
})

// Files of one patient (documents, X-rays, clinical images, lab attachments), newest first, keyset-paged.
const listFiles = async (c: any, where: string, scope: string, purposes: string[]) => {
  const p = c.get('principal'), q = c.req.query(), limit = parseLimit(q.limit); if (limit === null) throw bad('limit must be 1-100')
  const cur = decodeCursor(q.cursor); if (cur === null || (cur && (!isUuid(cur[1]) || Number.isNaN(Date.parse(cur[0]))))) throw bad('Invalid cursor')
  if (q.purpose !== undefined && !purposes.includes(q.purpose)) throw bad('Unknown purpose')
  const args: unknown[] = [p.clinicId, scope]; let sql = `clinic_id = $1 AND ${where} = $2 AND status = 'ready' AND voided_at IS NULL`
  if (q.purpose) { args.push(q.purpose); sql += ` AND purpose = $${args.length}` } else { args.push(purposes); sql += ` AND purpose = ANY($${args.length}::text[])` }
  if (cur) { args.push(cur[0], cur[1]); sql += ` AND (created_at, id) < ($${args.length - 1}::timestamptz, $${args.length}::uuid)` }
  args.push(limit + 1)
  const rows = await c.get('db').rows(`SELECT ${COLS} FROM file WHERE ${sql} ORDER BY created_at DESC, id DESC LIMIT $${args.length}`, args) as FileRow[]
  const r = page(rows, limit, (x) => encodeCursor(String(x.created_at), String(x.id)))
  return c.json({ items: r.items.map(view), nextCursor: r.nextCursor })
}
const CLINICAL = Object.entries(PURPOSES).filter(([, x]) => x.attach !== 'owner').map(([k]) => k)
filesRoutes.get('/patients/:id/files', async (c) => {
  const p = c.get('principal'); if (!p.permissions.has('clinical.view')) throw forbidden()
  const pid = c.req.param('id'); if (!isUuid(pid) || !(await c.get('db').rows('SELECT 1 FROM patient WHERE id = $1 AND clinic_id = $2', [pid, p.clinicId])).length) throw notFound()
  return listFiles(c, 'patient_id', pid, CLINICAL)
})
filesRoutes.get('/practice/lab/:id/files', async (c) => {
  const p = c.get('principal'); if (!p.permissions.has('practice.view') && !p.permissions.has('clinical.view')) throw forbidden()
  const id = c.req.param('id'); if (!isUuid(id) || !(await c.get('db').rows('SELECT 1 FROM lab_order WHERE id = $1 AND clinic_id = $2', [id, p.clinicId])).length) throw notFound()
  return listFiles(c, 'lab_order_id', id, ['lab_attachment'])
})
