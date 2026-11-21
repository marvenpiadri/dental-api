// Real PostgreSQL + in-memory file store: uploads are verified by their bytes, bounded, private, and never deleted.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { harness } from './pg/harness'

let h: Awaited<ReturnType<typeof harness>>, pid: string
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 10, 10])
const up = (who: string, bytes: Uint8Array, o: { type?: string; name?: string; len?: string; patient?: string } = {}) =>
  h.raw(who, 'POST', `/v1/patients/${o.patient ?? pid}/documents`, bytes, { 'content-type': o.type ?? 'application/pdf', 'x-filename': encodeURIComponent(o.name ?? 'xray é.pdf'), 'content-length': o.len ?? String(bytes.length) })

beforeAll(async () => { h = await harness(); pid = (await h.json(await h.call('recA', 'POST', '/v1/patients', { fullName: 'Doc Patient' }))).id })
afterAll(async () => { await h.drop() })

describe('documents', () => {
  it('uploads, lists, and downloads as a private attachment', async () => {
    const r = await up('dentA', PDF); expect(r.status).toBe(201); const { id } = await h.json(r)
    const l = await h.json(await h.call('dentA', 'GET', `/v1/patients/${pid}/documents`)); expect(l.items.map((x: any) => x.id)).toEqual([id]); expect(l.items[0].size).toBe(PDF.length)
    const d = await h.call('dentA', 'GET', `/v1/documents/${id}`); expect(d.status).toBe(200)
    expect(d.headers.get('content-disposition')).toContain("attachment; filename*=UTF-8''xray%20%C3%A9.pdf"); expect(d.headers.get('x-content-type-options')).toBe('nosniff'); expect(d.headers.get('cache-control')).toContain('no-store')
    expect(new Uint8Array(await d.arrayBuffer())).toEqual(PDF)
  })
  it('refuses wrong types, content that does not match its type, empty and oversized files', async () => {
    expect((await up('dentA', PDF, { type: 'text/html' })).status).toBe(415)
    const before = h.files.m.size
    expect((await up('dentA', new Uint8Array([1, 2, 3, 4, 5, 6]), { type: 'application/pdf' })).status).toBe(415) // bytes are not a PDF
    expect(h.files.m.size).toBe(before) // nothing left in the bucket
    expect((await h.db.rows("SELECT 1 FROM document WHERE NOT live")).length).toBe(0) // nor an unfinished row
    expect((await up('dentA', PDF, { len: '27000000' })).status).toBe(413)
    expect((await up('dentA', PDF, { name: '' })).status).toBe(400)
  })
  it('permissions and isolation: reception cannot upload, other clinics get 404', async () => {
    expect((await up('recA', PDF)).status).toBe(403)
    expect((await up('ownerB', PDF)).status).toBe(404)
    const id = (await h.db.rows<{ id: string }>('SELECT id FROM document LIMIT 1'))[0].id
    expect((await h.call('ownerB', 'GET', `/v1/documents/${id}`)).status).toBe(404)
    expect((await h.call('ownerB', 'GET', `/v1/patients/${pid}/documents`)).status).toBe(404)
    expect((await h.call('dentA', 'GET', '/v1/documents/not-a-uuid')).status).toBe(404)
  })
  it('lists in pages with a stable cursor', async () => {
    for (let i = 0; i < 3; i++) await up('dentA', PDF, { name: `f${i}.pdf` })
    const a = await h.json(await h.call('dentA', 'GET', `/v1/patients/${pid}/documents?limit=2`)); expect(a.items.length).toBe(2); expect(a.nextCursor).toBeTruthy()
    const b = await h.json(await h.call('dentA', 'GET', `/v1/patients/${pid}/documents?limit=2&cursor=${encodeURIComponent(a.nextCursor)}`))
    expect(new Set([...a.items, ...b.items].map((x: any) => x.id)).size).toBe(a.items.length + b.items.length)
    expect((await h.call('dentA', 'GET', `/v1/patients/${pid}/documents?cursor=zzz`)).status).toBe(400)
  })
  it('void hides the document but keeps the record and bytes; the database refuses delete or edit', async () => {
    const id = (await h.json(await up('dentA', PDF, { name: 'void-me.pdf' }))).id
    expect((await h.call('dentA', 'POST', `/v1/documents/${id}/void`, { reason: 'wrong patient' })).status).toBe(204) // dentist has clinical.void
    expect((await h.call('dentA', 'GET', `/v1/documents/${id}`)).status).toBe(404)
    expect((await h.db.rows('SELECT 1 FROM document WHERE id=$1', [id])).length).toBe(1)
    await expect(h.db.run('DELETE FROM document WHERE id=$1', [id])).rejects.toThrow()
    await expect(h.db.run("UPDATE document SET name='x' WHERE id=$1", [id])).rejects.toThrow()
  })
})
