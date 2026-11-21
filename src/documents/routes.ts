import { Hono } from 'hono'
import { ApiError, fail } from '../http/errors'
import { authenticate, requires } from '../http/middleware'
import type { AppEnv } from '../http/context'
import { decodeCursor, encodeCursor, page, parseLimit } from '../lib/pagination'
import { limitStream, PayloadTooLargeError } from '../lib/stream-limit'
import { isUuid, newId } from '../lib/ids'
import { toDb } from '../lib/time'

export const MAX_FILE_BYTES = 25 * 1024 * 1024
/** Allowed types and the magic bytes each must start with. The client's Content-Type is a claim; the bytes decide. */
const starts = (h: Uint8Array, sig: number[]) => h.length >= sig.length && sig.every((b, i) => h[i] === b)
const TYPES: Record<string, (h: Uint8Array) => boolean> = {
  'application/pdf': (h) => starts(h, [0x25, 0x50, 0x44, 0x46]),
  'image/jpeg': (h) => starts(h, [0xff, 0xd8, 0xff]),
  'image/png': (h) => starts(h, [0x89, 0x50, 0x4e, 0x47]),
  'image/webp': (h) => starts(h, [0x52, 0x49, 0x46, 0x46]) && h.length >= 12 && starts(h.subarray(8), [0x57, 0x45, 0x42, 0x50]),
}

export const documentRoutes = new Hono<AppEnv>()
documentRoutes.use('*', authenticate)
documentRoutes.onError((e, c) => { if (e instanceof ApiError) return fail(c, e); throw e })
const bad = (m = 'Invalid request') => new ApiError(400, 'bad_request', m)
const notFound = () => new ApiError(404, 'not_found', 'Not found')
const cleanName = (s: string | null) => (s ?? '').normalize('NFC').replace(/[\x00-\x1f\x7f/\\"]/g, '').trim().slice(0, 200)
const decode = (s: string | null) => { try { return s === null ? null : decodeURIComponent(s) } catch { return null } }

// Raw body upload: Content-Type = file type, X-Filename = (URI-encoded) name, Content-Length required. The stream is counted as it flows (never buffered).
// Authorization and ownership are checked BEFORE any byte is read. The row stays live=false until the bytes are stored and verified.
documentRoutes.post('/patients/:id/documents', requires('clinical.create'), async (c) => {
  const p = c.get('principal'), db = c.get('db'), pid = c.req.param('id')
  const type = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase(), name = cleanName(decode(c.req.header('x-filename') ?? null))
  const size = Number(c.req.header('content-length'))
  if (!TYPES[type]) throw new ApiError(415, 'unsupported_type', 'Only PDF, JPEG, PNG and WebP files are accepted')
  if (!name) throw bad('X-Filename is required')
  if (!Number.isInteger(size) || size < 1) throw new ApiError(411, 'length_required', 'Content-Length is required')
  if (size > MAX_FILE_BYTES) throw new ApiError(413, 'too_large', 'File is too large')
  if (!isUuid(pid) || !(await db.rows('SELECT 1 FROM patient WHERE id = $1 AND clinic_id = $2', [pid, p.clinicId])).length) throw notFound()
  if (!c.req.raw.body) throw bad('Empty body')
  const id = newId(), key = `${p.clinicId}/${pid}/${id}`
  await db.run('INSERT INTO document (id, clinic_id, patient_id, name, content_type, size, r2_key, live, uploaded_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,false,$8,$9)', [id, p.clinicId, pid, name, type, size, key, p.staffId, toDb(c.get('now'))])
  const undo = async () => { await c.get('files').delete(key).catch(() => undefined); await db.run('DELETE FROM document WHERE id = $1 AND clinic_id = $2 AND NOT live', [id, p.clinicId]).catch(() => undefined) }
  const counter = limitStream(MAX_FILE_BYTES)
  try {
    await c.get('files').put(key, c.req.raw.body.pipeThrough(counter.stream), size, type)
    if (counter.bytes() !== size) throw new Error('length mismatch')
    if (!TYPES[type](counter.head())) { await undo(); throw new ApiError(415, 'content_mismatch', 'The file content does not match its type') }
    if ((await db.run('UPDATE document SET live = true WHERE id = $1 AND clinic_id = $2 AND NOT live', [id, p.clinicId])) !== 1) throw new Error('could not activate document')
  } catch (e) {
    if (e instanceof ApiError) throw e
    await undo()
    if (e instanceof PayloadTooLargeError) throw new ApiError(413, 'too_large', 'File is too large')
    throw new ApiError(400, 'upload_failed', 'Upload did not complete; the file was not saved')
  }
  return c.json({ id }, 201)
})

documentRoutes.get('/patients/:id/documents', requires('clinical.view'), async (c) => {
  const p = c.get('principal'), q = c.req.query(), limit = parseLimit(q.limit); if (limit === null) throw bad('limit must be 1-100')
  const cur = decodeCursor(q.cursor); if (cur === null || (cur && (!isUuid(cur[1]) || Number.isNaN(Date.parse(cur[0]))))) throw bad('Invalid cursor')
  const pid = c.req.param('id'); if (!isUuid(pid) || !(await c.get('db').rows('SELECT 1 FROM patient WHERE id = $1 AND clinic_id = $2', [pid, p.clinicId])).length) throw notFound()
  const args: unknown[] = [p.clinicId, pid]; let after = ''
  if (cur) { args.push(cur[0], cur[1]); after = 'AND (created_at, id) < ($3::timestamptz, $4::uuid)' }
  args.push(limit + 1)
  const rows = await c.get('db').rows(`SELECT id, name, content_type, size, created_at FROM document WHERE clinic_id = $1 AND patient_id = $2 AND live AND voided_at IS NULL ${after} ORDER BY created_at DESC, id DESC LIMIT $${args.length}`, args)
  const r = page(rows, limit, (x) => encodeCursor(String(x.created_at), String(x.id)))
  return c.json({ items: r.items.map((x) => ({ id: x.id, name: x.name, contentType: x.content_type, size: Number(x.size), createdAt: x.created_at })), nextCursor: r.nextCursor })
})

// Download: authorize, then stream from the private bucket. Always an attachment, never sniffed or rendered by the browser.
documentRoutes.get('/documents/:id', requires('clinical.view'), async (c) => {
  const id = c.req.param('id'); if (!isUuid(id)) throw notFound()
  const [d] = await c.get('db').rows<{ name: string; content_type: string; r2_key: string }>('SELECT name, content_type, r2_key FROM document WHERE id = $1 AND clinic_id = $2 AND live AND voided_at IS NULL', [id, c.get('principal').clinicId])
  if (!d) throw notFound()
  const o = await c.get('files').get(d.r2_key); if (!o) throw notFound()
  return new Response(o.body, { headers: { 'Content-Type': d.content_type, 'Content-Length': String(o.size), 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(d.name)}`, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Cache-Control': 'private, no-store' } })
})
// Voiding hides the document and keeps the record and the bytes (clinical retention); removing bytes is a deliberate operator action.
documentRoutes.post('/documents/:id/void', requires('clinical.void'), async (c) => {
  const id = c.req.param('id'); if (!isUuid(id)) throw notFound()
  const b = await c.req.json().catch(() => null) as { reason?: unknown } | null
  if (!b || typeof b.reason !== 'string' || !b.reason.trim() || b.reason.length > 500) throw bad('A reason is required')
  const n = await c.get('db').run('UPDATE document SET voided_at = $1, void_reason = $2 WHERE id = $3 AND clinic_id = $4 AND voided_at IS NULL AND live', [toDb(c.get('now')), b.reason.trim(), id, c.get('principal').clinicId])
  if (n !== 1) throw notFound(); return c.body(null, 204)
})
