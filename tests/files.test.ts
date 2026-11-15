// Fake in-memory FileStore (mimics R2's FixedLengthStream: the byte count must equal the declared length). SQLite stand-in for the DB.
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createClinic } from '../src/admin/bootstrap'
import type { FileStore } from '../src/files/store'
import { MAX_FILE_BYTES } from '../src/files/routes'
import { sqliteDb } from './helpers/sqlite-db'
import { toDb } from '../src/lib/time'

const env = { TIDB_DATABASE_URL: 'x', PASSWORD_PEPPER: 'pepper', APP_ORIGIN: 'https://app.test', API_ORIGIN: 'https://api.test' }
const db = sqliteDb(), NOW = Date.parse('2026-11-16T07:00:00Z'), PW = 'correct horse battery'
const blobs = new Map<string, Uint8Array>()
const store: FileStore = {
  async put(key, body, size) { const chunks: Uint8Array[] = []; for await (const c of body as unknown as AsyncIterable<Uint8Array>) chunks.push(c); const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length }
    if (all.length !== size) throw new Error('length mismatch'); blobs.set(key, all) },
  async get(key) { const b = blobs.get(key); return b ? { body: new Blob([b]).stream(), size: b.length } : null },
  async delete(key) { blobs.delete(key) },
}
const app = createApp({ db: () => db, now: () => NOW, files: () => store })
const H = { origin: 'https://app.test', 'x-dontalist-csrf': '1' }
const ck: Record<string, string> = {}
const json = async (r: Response) => (await r.json()) as any
const login = async (email: string) => (await app.request('/v1/auth/login', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) }, env)).headers.get('set-cookie')!.split(';')[0]
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 1, 2, 3, 4, 5])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8])
const upload = (who: string, patient: string, bytes: Uint8Array, o: { type?: string; name?: string; length?: number } = {}) =>
  app.request(`/v1/patients/${patient}/documents`, { method: 'POST', headers: { ...H, cookie: ck[who], 'content-type': o.type ?? 'application/pdf', 'x-filename': encodeURIComponent(o.name ?? 'rapport é.pdf'), 'content-length': String(o.length ?? bytes.length) }, body: bytes }, env)
const get = (who: string, path: string, method = 'GET', body?: unknown) => app.request(path, { method, headers: { ...H, cookie: ck[who], 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, env)
let pA = '', pB = ''

beforeAll(async () => {
  const a = await createClinic(db, 'pepper', { clinicName: 'A', ownerEmail: 'owner@a.test', ownerName: 'O', password: PW })
  await createClinic(db, 'pepper', { clinicName: 'B', ownerEmail: 'owner@b.test', ownerName: 'Ob', password: PW })
  const hash = (db.raw.prepare("SELECT password_hash h FROM staff WHERE email_norm='owner@a.test'").get() as any).h
  for (const [id, role] of [['dent', 'dentist'], ['rec', 'reception']]) db.raw.prepare('INSERT INTO staff (id,clinic_id,email_norm,name,role,password_hash,created_at) VALUES (?,?,?,?,?,?,?)').run(id, a.clinicId, `${id}@a.test`, id, role, hash, toDb(NOW))
  for (const w of ['owner@a', 'owner@b', 'dent@a', 'rec@a']) ck[w] = await login(`${w}.test`)
  const mk = async (who: string, n: string) => (await json(await get(who, '/v1/patients', 'POST', { fullName: n }))).id
  pA = await mk('owner@a', 'Pat A'); pB = await mk('owner@b', 'Pat B')
})

describe('documents', () => {
  it('uploads, lists and downloads exact bytes as a sandboxed attachment', async () => {
    const r = await upload('dent@a', pA, PDF); expect(r.status).toBe(201)
    const id = (await json(r)).id
    const list = await json(await get('dent@a', `/v1/patients/${pA}/documents`)); expect(list.items[0]).toMatchObject({ id, name: 'rapport é.pdf', contentType: 'application/pdf', size: PDF.length })
    const dl = await get('dent@a', `/v1/documents/${id}`)
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(PDF)
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment; filename\*=UTF-8''rapport%20%C3%A9\.pdf$/); expect(dl.headers.get('x-content-type-options')).toBe('nosniff'); expect(dl.headers.get('cache-control')).toMatch(/no-store/)
  })
  it('rejects wrong types, mismatched content, missing length, oversize, and a lying Content-Length - leaving nothing behind', async () => {
    const before = blobs.size, rows = () => (db.raw.prepare('SELECT COUNT(*) n FROM document').get() as any).n
    const r0 = rows()
    expect((await upload('dent@a', pA, PDF, { type: 'text/html' })).status).toBe(415)
    expect((await upload('dent@a', pA, PNG, { type: 'application/pdf' })).status).toBe(415) // bytes are a PNG, claimed PDF
    expect((await upload('dent@a', pA, PDF, { length: MAX_FILE_BYTES + 1 })).status).toBe(413)
    expect((await upload('dent@a', pA, PDF, { length: PDF.length + 10 })).status).toBeGreaterThanOrEqual(400) // longer than the body
    expect((await upload('dent@a', pA, PDF, { length: PDF.length - 3 })).status).toBeGreaterThanOrEqual(400) // shorter than the body
    expect((await upload('dent@a', pA, PDF, { name: '' })).status).toBe(400)
    expect(blobs.size).toBe(before); expect(rows()).toBe(r0)
  })
  it('enforces permissions and clinic isolation before reading any bytes', async () => {
    const id = (await json(await upload('dent@a', pA, PNG, { type: 'image/png', name: 'x.png' }))).id
    expect((await upload('rec@a', pA, PDF)).status).toBe(403)
    expect((await get('rec@a', `/v1/documents/${id}`)).status).toBe(403)
    expect((await upload('owner@a', pB, PDF)).status).toBe(404) // another clinic's patient
    expect((await get('owner@b', `/v1/documents/${id}`)).status).toBe(404)
    expect((await get('owner@b', `/v1/patients/${pA}/documents`)).status).toBe(404)
  })
  it('voiding needs a reason, is clinic-scoped, hides the document, and keeps the record and bytes', async () => {
    const id = (await json(await upload('dent@a', pA, PNG, { type: 'image/png', name: 'v.png' }))).id
    const path = `/v1/documents/${id}/void`
    expect((await get('dent@a', path, 'POST', { reason: '  ' })).status).toBe(400)
    expect((await get('rec@a', path, 'POST', { reason: 'wrong patient' })).status).toBe(403)
    expect((await get('owner@b', path, 'POST', { reason: 'x' })).status).toBe(404)
    expect((await get('dent@a', path, 'POST', { reason: 'wrong patient' })).status).toBe(204)
    expect((await get('dent@a', path, 'POST', { reason: 'again' })).status).toBe(404) // already voided
    expect((await get('dent@a', `/v1/documents/${id}`)).status).toBe(404)
    expect((await json(await get('dent@a', `/v1/patients/${pA}/documents`))).items.some((x: any) => x.id === id)).toBe(false)
    const row = db.raw.prepare('SELECT void_reason r, r2_key k FROM document WHERE id = ?').get(id) as any
    expect(row.r).toBe('wrong patient'); expect(blobs.has(row.k)).toBe(true)
  })
  it('paginates the list with a keyset cursor', async () => {
    const p = (await json(await get('owner@a', '/v1/patients', 'POST', { fullName: 'Pager' }))).id
    for (let i = 0; i < 3; i++) await upload('dent@a', p, PDF, { name: `d${i}.pdf` })
    const p1 = await json(await get('dent@a', `/v1/patients/${p}/documents?limit=2`)); expect(p1.items).toHaveLength(2); expect(p1.nextCursor).toBeTruthy()
    const p2 = await json(await get('dent@a', `/v1/patients/${p}/documents?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`))
    expect(p2.items).toHaveLength(1); expect(new Set([...p1.items, ...p2.items].map((x: any) => x.id)).size).toBe(3)
  })
})
