// The REAL store (aws4fetch signing, presigned PUT/GET, HEAD, Range, DELETE) over real HTTP against a small S3 server that VALIDATES AWS Signature V4
// exactly as the spec says (query-string and header auth, signed headers, expiry), written independently with node:crypto.
// Tier: S3 protocol. Proves our signing and requests are valid SigV4; it is NOT a test of Cloudflare R2 itself.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { s3Store, unconfiguredStore, type FileStore } from '../src/files/store'

const AK = 'TESTKEY', SECRET = 'testsecret/with+chars', BUCKET = 'dontalist'
const hmac = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest()
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

/** SigV4 check per the AWS spec. Returns null when valid, otherwise the reason. */
function verify(req: IncomingMessage, now: number): string | null {
  const url = new URL(req.url!, `http://${req.headers.host}`), q = url.searchParams
  let sig: string, signed: string, cred: string, date: string, payload: string
  if (q.has('X-Amz-Signature')) {
    sig = q.get('X-Amz-Signature')!; signed = q.get('X-Amz-SignedHeaders') ?? ''; cred = q.get('X-Amz-Credential') ?? ''; date = q.get('X-Amz-Date') ?? ''; payload = 'UNSIGNED-PAYLOAD'
    const t = Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), +date.slice(9, 11), +date.slice(11, 13), +date.slice(13, 15))
    if (!(now >= t - 60_000 && now <= t + Number(q.get('X-Amz-Expires')) * 1000)) return 'expired'
  } else {
    const m = /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/.exec(String(req.headers.authorization)); if (!m) return 'no auth'
    cred = m[1]; signed = m[2]; sig = m[3]; date = String(req.headers['x-amz-date']); payload = String(req.headers['x-amz-content-sha256'])
  }
  const [ak, day, region, service, term] = cred.split('/'); if (ak !== AK || term !== 'aws4_request') return 'bad credential'
  const query = [...q].filter(([k]) => k !== 'X-Amz-Signature').map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] + '=' + a[1] < b[0] + '=' + b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&')
  const headers = signed.split(';').map((h) => `${h}:${String(req.headers[h] ?? '').trim()}\n`).join('')
  const canonical = [req.method, url.pathname, query, headers, signed, payload].join('\n')
  const scope = `${day}/${region}/${service}/aws4_request`
  const sts = ['AWS4-HMAC-SHA256', date, scope, createHash('sha256').update(canonical).digest('hex')].join('\n')
  const key = hmac(hmac(hmac(hmac('AWS4' + SECRET, day), region), service), 'aws4_request')
  const want = hmac(key, sts).toString('hex')
  return want.length === sig.length && timingSafeEqual(Buffer.from(want), Buffer.from(sig)) ? null : 'signature mismatch'
}

let server: Server, store: FileStore, endpoint: string
const objects = new Map<string, { bytes: Buffer; type: string }>()
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer)
    const why = verify(req, Date.now()); if (why) { res.writeHead(403); return res.end(why) }
    const url = new URL(req.url!, 'http://x'), key = decodeURIComponent(url.pathname.replace(`/${BUCKET}/`, '')), o = objects.get(key)
    if (req.method === 'PUT') { objects.set(key, { bytes: Buffer.concat(chunks), type: String(req.headers['content-type']) }); res.writeHead(200); return res.end() }
    if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end() }
    if (!o) { res.writeHead(404); return res.end() }
    const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range)), body = range ? o.bytes.subarray(+range[1], +range[2] + 1) : o.bytes
    res.writeHead(range ? 206 : 200, { 'Content-Type': url.searchParams.get('response-content-type') ?? o.type, 'Content-Length': String(req.method === 'HEAD' ? o.bytes.length : body.length), ...(url.searchParams.get('response-content-disposition') && { 'Content-Disposition': url.searchParams.get('response-content-disposition')! }) })
    res.end(req.method === 'HEAD' ? undefined : body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  store = s3Store({ R2_ENDPOINT: `${endpoint}/${BUCKET}`, R2_ACCESS_KEY_ID: AK, R2_SECRET_ACCESS_KEY: SECRET }) // bucket taken from the endpoint path, as in the R2 string
})
afterAll(() => { server.close() })

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, ...Array(200).fill(7)])
const put = (url: string, body: Uint8Array | undefined, type?: string) => fetch(url, { method: 'PUT', headers: type ? { 'Content-Type': type } : {}, body })
describe('S3 store against a SigV4-validating server', () => {
  it('browser-style PUT to a presigned URL, then HEAD, Range peek, presigned GET, DELETE', async () => {
    const key = 'clinic-1/xray/abc'
    expect(await store.head(key)).toBeNull()
    expect((await put(await store.presignPut(key, 'image/png', 60), PNG, 'image/png')).status).toBe(200)
    expect(await store.head(key)).toEqual({ size: PNG.length, contentType: 'image/png' })
    expect(await store.peek(key, 8)).toEqual(PNG.subarray(0, 8)) // only the first bytes travel
    const g = await fetch(await store.presignGet(key, { contentType: 'image/png', filename: 'x-ray é.png', inline: true }, 60)); expect(g.status).toBe(200)
    expect(new Uint8Array(await g.arrayBuffer())).toEqual(PNG); expect(g.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''x-ray%20%C3%A9.png")
    const d = await fetch(await store.presignGet(key, { contentType: 'application/pdf', filename: 'a.pdf', inline: false }, 60)); expect(d.headers.get('content-disposition')).toMatch(/^attachment;/)
    await store.delete(key); expect(await store.head(key)).toBeNull()
    await store.delete(key) // deleting what is gone is not an error
  })
  it('a signed upload URL cannot be abused: other type, no type, other key, tampering, expiry', async () => {
    const url = await store.presignPut('clinic-1/xray/def', 'image/png', 60)
    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host') // the type is part of the signature
    for (const [what, r] of [['other type', await put(url, PNG, 'text/html')], ['no type', await put(url, PNG)], ['other key', await put(url.replace('/def', '/other'), PNG, 'image/png')],
      ['tampered', await put(url.replace('X-Amz-Signature=', 'X-Amz-Signature=0'), PNG, 'image/png')], ['longer expiry', await put(url.replace('X-Amz-Expires=60', 'X-Amz-Expires=99999'), PNG, 'image/png')]] as const)
      expect(r.status, what).toBe(403)
    expect(objects.has('clinic-1/xray/def')).toBe(false) // none of the attempts stored anything
    const short = await store.presignPut('clinic-1/xray/ghi', 'image/png', 1); await new Promise((r) => setTimeout(r, 2200))
    expect((await put(short, PNG, 'image/png')).status).toBe(403); expect(objects.has('clinic-1/xray/ghi')).toBe(false) // expired
  })
  it('a read URL for one object does not open another, and a wrong secret is refused', async () => {
    await put(await store.presignPut('c/a', 'image/png', 60), PNG, 'image/png'); await put(await store.presignPut('c/b', 'image/png', 60), PNG, 'image/png')
    const u = await store.presignGet('c/a', { contentType: 'image/png', filename: 'a.png', inline: true }, 60)
    expect((await fetch(u.replace('/c/a', '/c/b'))).status).toBe(403)
    const wrong = s3Store({ R2_ENDPOINT: `${endpoint}/${BUCKET}`, R2_ACCESS_KEY_ID: AK, R2_SECRET_ACCESS_KEY: 'not-the-secret' })
    await expect(wrong.head('c/a')).rejects.toThrow('403')
  })
  it('without configuration every call fails closed; a bucket is required', async () => {
    await expect(unconfiguredStore.presignPut('a', 'image/png', 1)).rejects.toThrow('not configured')
    expect(s3Store({})).toBe(unconfiguredStore)
    expect(() => s3Store({ R2_ENDPOINT: 'https://x.r2.cloudflarestorage.com', R2_ACCESS_KEY_ID: 'a', R2_SECRET_ACCESS_KEY: 'b' })).toThrow('bucket')
  })
})
