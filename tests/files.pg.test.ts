// Central file service on real PostgreSQL with an in-memory store: authorize -> signed URL -> bytes -> verify -> attach -> private read -> void/delete/purge.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { harness, NOW } from './pg/harness'
import { purgeFiles } from '../src/files/reap'

let h: Awaited<ReturnType<typeof harness>>, pid: string, other: string
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 10, 10])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3, 4])
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
const DICOM = new Uint8Array(140); DICOM.set([0x44, 0x49, 0x43, 0x4d], 128)

/** The whole client flow. Returns the id and the responses so tests can break any step. */
async function upload(who: string, o: { purpose: string; bytes: Uint8Array; type: string; name?: string; declared?: number; extra?: object; putType?: string; putBytes?: Uint8Array }) {
  const r = await h.call(who, 'POST', '/v1/files', { purpose: o.purpose, name: o.name ?? 'scan é.pdf', contentType: o.type, size: o.declared ?? o.bytes.length, ...o.extra })
  if (r.status !== 201) return { init: r, id: '' as string, complete: undefined as Response | undefined }
  const { id, upload: u } = await h.json(r)
  expect(h.files.browserPut(u.url, o.putBytes ?? o.bytes, o.putType ?? u.headers['Content-Type'])).toBe(200)
  return { init: r, id, complete: await h.call(who, 'POST', `/v1/files/${id}/complete`) }
}
const patientFile = (purpose: string, bytes: Uint8Array, type: string, who = 'dentA', patient = pid) => upload(who, { purpose, bytes, type, extra: { patientId: patient } })

beforeAll(async () => {
  h = await harness()
  pid = (await h.json(await h.call('recA', 'POST', '/v1/patients', { fullName: 'File Patient' }))).id
  other = (await h.json(await h.call('recB', 'POST', '/v1/patients', { fullName: 'Other Clinic' }))).id
})
afterAll(async () => { await h.drop() })

describe('upload flow', () => {
  it('uploads straight to the bucket, verifies, lists, and reads through a short-lived URL', async () => {
    const u = await patientFile('xray', DICOM, 'application/dicom'); expect(u.complete!.status).toBe(200)
    const meta = await h.json(u.complete!); expect(meta).toMatchObject({ purpose: 'xray', patientId: pid, size: 140, contentType: 'application/dicom' })
    const l = await h.json(await h.call('dentA', 'GET', `/v1/patients/${pid}/files`)); expect(l.items.map((x: any) => x.id)).toContain(u.id)
    const c = await h.call('dentA', 'GET', `/v1/files/${u.id}/content`); expect(c.status).toBe(302)
    expect(c.headers.get('location')).toContain(`/get/${meta ? `${h.A.clinicId}/xray/${u.id}` : ''}`); expect(c.headers.get('location')).toContain('inline=false'); expect(c.headers.get('referrer-policy')).toBe('no-referrer')
    const key = [...h.files.m.keys()].find((k) => k.endsWith(u.id))!; expect(key).toBe(`${h.A.clinicId}/xray/${u.id}`) // random ids only: no patient data in the key
    const img = await patientFile('clinical_image', PNG, 'image/png'); expect((await h.call('dentA', 'GET', `/v1/files/${img.id}/content`)).headers.get('location')).toContain('inline=true')
  })
  it('the API never carries file bytes: bodies over 64 KB are refused', async () => {
    expect((await h.raw('dentA', 'POST', '/v1/files', new Uint8Array(70_000), { 'content-type': 'application/json' })).status).toBe(413)
  })
  it('refuses the wrong type, size, purpose and association before issuing any URL', async () => {
    const base = { purpose: 'patient_document', name: 'a.pdf', contentType: 'application/pdf', size: 10, patientId: pid }
    for (const [patch, status] of [[{ contentType: 'text/html' }, 415], [{ contentType: 'application/dicom' }, 415], [{ size: 30 * 1024 * 1024 }, 413], [{ size: 0 }, 400], [{ size: 1.5 }, 400], [{ name: '  ' }, 400], [{ purpose: 'nope' }, 400], [{ patientId: 'x' }, 404], [{ patientId: other }, 404]] as const)
      expect((await h.call('dentA', 'POST', '/v1/files', { ...base, ...patch })).status, JSON.stringify(patch)).toBe(status)
    expect((await h.call('dentA', 'POST', '/v1/files', { ...base, purpose: 'xray', contentType: 'application/dicom', size: 101 * 1024 * 1024 })).status).toBe(413) // per-purpose cap
    expect((await h.call('dentA', 'POST', '/v1/files', { ...base, purpose: 'patient_photo', contentType: 'application/pdf', patientId: undefined, subjectId: pid })).status).toBe(415) // avatars: images only
  })
  it('a signed URL only accepts the declared Content-Type', async () => {
    const r = await upload('dentA', { purpose: 'patient_document', bytes: PDF, type: 'application/pdf', putType: 'text/html', extra: { patientId: pid } }).catch((e) => e)
    expect(String(r)).toContain('expected 403') // the fake bucket (like R2) refuses a PUT whose type was not signed
  })
  it('complete: not uploaded yet, wrong size, wrong bytes, already done, someone else\'s', async () => {
    const init = await h.json(await h.call('dentA', 'POST', '/v1/files', { purpose: 'patient_document', name: 'a.pdf', contentType: 'application/pdf', size: PDF.length, patientId: pid }))
    expect((await h.call('dentA', 'POST', `/v1/files/${init.id}/complete`)).status).toBe(409) // retryable: nothing lost
    h.files.browserPut(init.upload.url, PDF, 'application/pdf')
    expect((await h.call('recA', 'POST', `/v1/files/${init.id}/complete`)).status).toBe(404) // only the uploader finishes it
    expect((await h.call('dentA', 'POST', `/v1/files/${init.id}/complete`)).status).toBe(200)
    expect((await h.call('dentA', 'POST', `/v1/files/${init.id}/complete`)).status).toBe(200) // idempotent after a lost response
    const wrongSize = await upload('dentA', { purpose: 'patient_document', bytes: PDF, type: 'application/pdf', putBytes: new Uint8Array([...PDF, 1, 2, 3]), extra: { patientId: pid } })
    expect(wrongSize.complete!.status).toBe(422); expect(h.files.m.has(`${h.A.clinicId}/patient_document/${wrongSize.id}`)).toBe(false) // object and row removed
    const fake = await upload('dentA', { purpose: 'patient_document', bytes: new Uint8Array([1, 2, 3, 4, 5, 6]), type: 'application/pdf', extra: { patientId: pid } })
    expect(fake.complete!.status).toBe(415); expect(h.files.m.has(`${h.A.clinicId}/patient_document/${fake.id}`)).toBe(false)
    expect((await h.db.rows('SELECT 1 FROM file WHERE id = $1', [fake.id])).length).toBe(0)
  })
  it('limits unfinished uploads per person', async () => {
    const body = { purpose: 'patient_document', name: 'a.pdf', contentType: 'application/pdf', size: 10, patientId: pid }
    let last = 201; for (let i = 0; i < 60 && last === 201; i++) last = (await h.call('acctA', 'POST', '/v1/files', { ...body })).status
    expect([403, 429]).toContain(last) // accountant has no clinical.create (403); the cap is exercised below with a permitted user
    let status = 201; for (let i = 0; i < 60 && status === 201; i++) status = (await h.call('ownerA', 'POST', '/v1/files', body)).status
    expect(status).toBe(429)
    await h.db.run("DELETE FROM file WHERE status = 'pending'")
  })
})

describe('authorization and clinic isolation', () => {
  let fid: string
  beforeAll(async () => { fid = (await patientFile('xray', JPG, 'image/jpeg')).id })
  it('only roles with the purpose\'s permission can upload or read', async () => {
    expect((await h.call('recA', 'POST', '/v1/files', { purpose: 'xray', name: 'x.jpg', contentType: 'image/jpeg', size: 8, patientId: pid })).status).toBe(403) // reception: no clinical.create
    expect((await h.call('recA', 'GET', `/v1/files/${fid}`)).status).toBe(403) // nor clinical.view
    expect((await h.call('recA', 'GET', `/v1/files/${fid}/content`)).status).toBe(403)
    expect((await h.call('recA', 'GET', `/v1/patients/${pid}/files`)).status).toBe(403)
    expect((await h.call('dentA', 'GET', `/v1/files/${fid}`)).status).toBe(200)
  })
  it('another clinic cannot see, read, complete, void or list it', async () => {
    for (const [m, path, body] of [['GET', `/v1/files/${fid}`], ['GET', `/v1/files/${fid}/content`], ['POST', `/v1/files/${fid}/complete`], ['POST', `/v1/files/${fid}/void`, { reason: 'x' }], ['DELETE', `/v1/files/${fid}`]] as const)
      expect((await h.call('ownerB', m, path, body)).status, `${m} ${path}`).toBe(404)
    expect((await h.call('ownerB', 'GET', `/v1/patients/${pid}/files`)).status).toBe(404)
    expect((await h.call('ownerB', 'POST', '/v1/files', { purpose: 'xray', name: 'x.jpg', contentType: 'image/jpeg', size: 8, patientId: pid })).status).toBe(404)
  })
  it('needs a session', async () => {
    expect((await h.app.request(`/v1/files/${fid}/content`, {}, { PASSWORD_PEPPER: 'p', APP_ORIGIN: 'https://app.test', API_ORIGIN: 'https://api.test' })).status).toBe(401)
  })
  it('lists purposes with this user\'s upload rights', async () => {
    const r = await h.json(await h.call('recA', 'GET', '/v1/files/purposes'))
    expect(r.xray).toMatchObject({ lossless: true, canUpload: false, maxBytes: 100 * 1024 * 1024 }); expect(r.patient_photo.canUpload).toBe(true); expect(r.clinical_image.lossless).toBe(true)
  })
})

describe('clinical files are retained', () => {
  it('void hides the file, keeps record and bytes; deleting is impossible, in the API and in the database', async () => {
    const f = await patientFile('patient_document', PDF, 'application/pdf'); const key = `${h.A.clinicId}/patient_document/${f.id}`
    expect((await h.call('dentA', 'DELETE', `/v1/files/${f.id}`)).status).toBe(409)
    expect((await h.call('recA', 'POST', `/v1/files/${f.id}/void`, { reason: 'x' })).status).toBe(403)
    expect((await h.call('dentA', 'POST', `/v1/files/${f.id}/void`, {})).status).toBe(400)
    expect((await h.call('dentA', 'POST', `/v1/files/${f.id}/void`, { reason: 'wrong patient' })).status).toBe(204)
    expect((await h.call('dentA', 'GET', `/v1/files/${f.id}/content`)).status).toBe(404)
    expect((await h.json(await h.call('dentA', 'GET', `/v1/patients/${pid}/files`))).items.map((x: any) => x.id)).not.toContain(f.id)
    expect(h.files.m.has(key)).toBe(true)
    await expect(h.db.run('DELETE FROM file WHERE id = $1', [f.id])).rejects.toThrow()
    await expect(h.db.run("UPDATE file SET name = 'x' WHERE id = $1", [f.id])).rejects.toThrow()
    expect(await purgeFiles(h.db, h.files.store, NOW + 10 * 3_600_000)).toBe(0); expect(h.files.m.has(key)).toBe(true) // purge never touches clinical files
  })
  it('lab attachments belong to the order, show in the patient\'s files, and follow lab permissions', async () => {
    const lab = (await h.json(await h.call('dentA', 'POST', '/v1/practice/lab', { patientId: pid, work: 'Crown', lab: 'LabX', due: '2026-12-01' }))).id
    const f = await upload('ownerA', { purpose: 'lab_attachment', bytes: JPG, type: 'image/jpeg', extra: { labOrderId: lab } }); expect(f.complete!.status).toBe(200)
    expect((await h.json(await h.call('ownerA', 'GET', `/v1/practice/lab/${lab}/files`))).items.map((x: any) => x.id)).toEqual([f.id])
    expect((await h.json(await h.call('dentA', 'GET', `/v1/patients/${pid}/files?purpose=lab_attachment`))).items.map((x: any) => x.id)).toEqual([f.id])
    expect((await h.call('dentA', 'GET', `/v1/files/${f.id}/content`)).status).toBe(302)
    expect((await h.call('ownerB', 'POST', '/v1/files', { purpose: 'lab_attachment', name: 'x.jpg', contentType: 'image/jpeg', size: 8, labOrderId: lab })).status).toBe(404)
    expect((await h.call('dentA', 'GET', `/v1/patients/${pid}/files?purpose=patient_photo`)).status).toBe(400)
  })
  it('paginates newest first with a cursor', async () => {
    for (let i = 0; i < 3; i++) await patientFile('clinical_image', PNG, 'image/png')
    const a = await h.json(await h.call('dentA', 'GET', `/v1/patients/${pid}/files?purpose=clinical_image&limit=2`)); expect(a.items.length).toBe(2); expect(a.nextCursor).toBeTruthy()
    const b = await h.json(await h.call('dentA', 'GET', `/v1/patients/${pid}/files?purpose=clinical_image&limit=2&cursor=${a.nextCursor}`))
    expect(new Set([...a.items, ...b.items].map((x: any) => x.id)).size).toBe(a.items.length + b.items.length)
    expect((await h.call('dentA', 'GET', `/v1/patients/${pid}/files?limit=101`)).status).toBe(400)
  })
})

describe('pictures: attach, replace, remove, purge', () => {
  it('a patient photo attaches to its owner, replacing deletes the old bytes, removing clears it', async () => {
    const a = await upload('recA', { purpose: 'patient_photo', bytes: JPG, type: 'image/jpeg', extra: { subjectId: pid } }); expect(a.complete!.status).toBe(200)
    expect((await h.json(await h.call('recA', 'GET', `/v1/patients/${pid}`))).photoFileId).toBe(a.id)
    const b = await upload('recA', { purpose: 'patient_photo', bytes: PNG, type: 'image/png', extra: { subjectId: pid } }); expect(b.complete!.status).toBe(200)
    expect((await h.json(await h.call('recA', 'GET', `/v1/patients/${pid}`))).photoFileId).toBe(b.id)
    expect(h.files.m.has(`${h.A.clinicId}/patient_photo/${a.id}`)).toBe(false); expect((await h.db.rows('SELECT 1 FROM file WHERE id = $1', [a.id])).length).toBe(0) // old bytes and row gone
    expect((await h.call('recA', 'GET', `/v1/files/${b.id}/content`)).status).toBe(302)
    expect((await h.call('recA', 'DELETE', `/v1/files/${b.id}`)).status).toBe(204)
    expect((await h.json(await h.call('recA', 'GET', `/v1/patients/${pid}`))).photoFileId).toBeNull(); expect(h.files.m.size).toBeGreaterThan(0); expect(h.files.m.has(`${h.A.clinicId}/patient_photo/${b.id}`)).toBe(false)
    expect((await h.call('recA', 'GET', `/v1/files/${b.id}/content`)).status).toBe(404)
  })
  it('photos need the owner row in this clinic and the right permission', async () => {
    expect((await h.call('recA', 'POST', '/v1/files', { purpose: 'patient_photo', name: 'a.jpg', contentType: 'image/jpeg', size: 8, subjectId: other })).status).toBe(404)
    expect((await h.call('acctA', 'POST', '/v1/files', { purpose: 'patient_photo', name: 'a.jpg', contentType: 'image/jpeg', size: 8, subjectId: pid })).status).toBe(403)
  })
  it('staff, dentist and product pictures use the same service', async () => {
    const me = (await h.json(await h.call('dentA', 'GET', '/v1/auth/me'))).id
    const s = await upload('dentA', { purpose: 'staff_photo', bytes: JPG, type: 'image/jpeg', extra: { subjectId: me } }); expect(s.complete!.status).toBe(200) // own photo without team.edit
    expect((await h.json(await h.call('ownerA', 'GET', '/v1/staff'))).items.find((x: any) => x.id === me).photoFileId).toBe(s.id)
    const other2 = (await h.json(await h.call('ownerA', 'GET', '/v1/auth/me'))).id
    expect((await h.call('dentA', 'POST', '/v1/files', { purpose: 'staff_photo', name: 'a.jpg', contentType: 'image/jpeg', size: 8, subjectId: other2 })).status).toBe(403) // not someone else's
    const d = (await h.json(await h.call('ownerA', 'POST', '/v1/dentists', { name: 'Dr Pic' }))).id
    const dp = await upload('ownerA', { purpose: 'dentist_photo', bytes: PNG, type: 'image/png', extra: { subjectId: d } }); expect(dp.complete!.status).toBe(200)
    expect((await h.json(await h.call('recA', 'GET', '/v1/dentists'))).items.find((x: any) => x.id === d).photoFileId).toBe(dp.id)
    expect((await h.call('recA', 'GET', `/v1/files/${dp.id}/content`)).status).toBe(302) // reception sees dentist pictures (appointments.view)
    const item = (await h.json(await h.call('ownerA', 'POST', '/v1/practice/stock', { name: 'Picture item', qty: 1, min: 0 }))).id
    const pi = await upload('ownerA', { purpose: 'product_image', bytes: JPG, type: 'image/jpeg', extra: { subjectId: item } }); expect(pi.complete!.status).toBe(200)
    expect((await h.json(await h.call('ownerA', 'GET', '/v1/practice/stock?limit=100'))).items.find((x: any) => x.id === item).photoFileId).toBe(pi.id)
    expect((await h.call('acctA', 'GET', `/v1/files/${pi.id}/content`)).status).toBe(302); expect((await h.call('recA', 'GET', `/v1/files/${pi.id}/content`)).status).toBe(403)
  })
  it('two simultaneous completes attach once', async () => {
    const init = await h.json(await h.call('recA', 'POST', '/v1/files', { purpose: 'patient_photo', name: 'a.jpg', contentType: 'image/jpeg', size: JPG.length, subjectId: pid }))
    h.files.browserPut(init.upload.url, JPG, 'image/jpeg')
    const rs = await Promise.all([1, 2, 3].map(() => h.call('recA', 'POST', `/v1/files/${init.id}/complete`)))
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200])
    expect((await h.json(await h.call('recA', 'GET', `/v1/patients/${pid}`))).photoFileId).toBe(init.id)
    expect((await h.db.rows("SELECT 1 FROM file WHERE purpose = 'patient_photo' AND subject_id = $1 AND voided_at IS NULL", [pid])).length).toBe(1)
  })
  it('purge removes abandoned uploads and leftover removed pictures, nothing else', async () => {
    const old = await h.json(await h.call('recA', 'POST', '/v1/files', { purpose: 'patient_photo', name: 'a.jpg', contentType: 'image/jpeg', size: JPG.length, subjectId: pid }))
    h.files.browserPut(old.upload.url, JPG, 'image/jpeg') // uploaded but never completed
    expect(await purgeFiles(h.db, h.files.store, NOW)).toBe(0) // too recent
    const later = NOW + 2 * 3_600_000
    expect(await purgeFiles(h.db, h.files.store, later)).toBe(1)
    expect(h.files.m.has(`${h.A.clinicId}/patient_photo/${old.id}`)).toBe(false)
    expect((await h.json(await h.call('recA', 'GET', `/v1/patients/${pid}`))).photoFileId).not.toBeNull() // the live photo is untouched
  })
})
