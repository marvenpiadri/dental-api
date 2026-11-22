// Shared API test setup on a real PostgreSQL: two clinics (A, B), staff with several roles, logged in.
import { createApp } from '../../src/app'
import { createClinic } from '../../src/admin/bootstrap'
import { httpPasswordService, type PasswordService } from '../../src/auth/password-service'
import { handle } from '../../password-service/src/handler'
import { testDb } from './db'
import type { FileStore } from '../../src/files/store'

/**
 * In-memory FileStore (tier: fake, not R2). Presigned URLs are `https://files.test/<put|get>/<key>`; `browserPut` plays the browser PUTting to a URL.
 * The real S3 signing and HTTP is exercised separately by files.s3.test.ts.
 */
export function fakeStore() {
  const m = new Map<string, { bytes: Uint8Array; type: string }>(), signed = new Map<string, string>()
  const store: FileStore = {
    presignPut: async (k, type) => { const u = `https://files.test/put/${k}`; signed.set(u, type); return u },
    presignGet: async (k, o) => `https://files.test/get/${k}?inline=${o.inline}&name=${encodeURIComponent(o.filename)}`,
    head: async (k) => { const o = m.get(k); return o ? { size: o.bytes.length, contentType: o.type } : null },
    peek: async (k, n) => m.get(k)?.bytes.subarray(0, n) ?? null,
    delete: async (k) => { m.delete(k) },
  }
  /** The browser's PUT to the presigned URL. Like R2, it refuses a Content-Type that is not the one that was signed. */
  const browserPut = (url: string, bytes: Uint8Array, type: string) => {
    if (signed.get(url) !== type) return 403
    m.set(url.replace('https://files.test/put/', ''), { bytes, type }); return 200
  }
  return { store, m, browserPut }
}

export const NOW = Date.parse('2026-11-16T07:00:00Z'), PW = 'correct horse battery'
export const SERVICE_SECRET = 'test-secret-test-secret-test-secret-0123'
/** The REAL password service (Argon2id, HMAC check) called in-process: no network, same code that is deployed. */
export const testPasswords = (o: { fetch?: typeof fetch; timeoutMs?: number } = {}): PasswordService => httpPasswordService({ url: 'http://password.test', secret: SERVICE_SECRET, fetch: o.fetch ?? ((u, i) => handle(new Request(u as string, i), { HASH_SECRET: SERVICE_SECRET })), timeoutMs: o.timeoutMs })
const env = { PASSWORD_PEPPER: 'pepper', APP_ORIGIN: 'https://app.test', API_ORIGIN: 'https://api.test' }
const H = { origin: 'https://app.test', 'x-dontalist-csrf': '1', 'content-type': 'application/json' }

export async function harness() {
  const { db, drop, url } = await testDb(20)
  const files = fakeStore(), passwords = testPasswords(), app = createApp({ db: () => db, now: () => NOW, files: () => files.store, passwords: () => passwords })
  const A = await createClinic(db, passwords, { clinicName: 'A', ownerEmail: 'owner@a.test', ownerName: 'OwnerA', password: PW }, NOW)
  const B = await createClinic(db, passwords, { clinicName: 'B', ownerEmail: 'owner@b.test', ownerName: 'OwnerB', password: PW }, NOW)
  const hash = await passwords.hash(PW)
  const cookies: Record<string, string> = {}
  const add = async (key: string, clinicId: string, role: string) =>
    db.run('INSERT INTO staff (id,clinic_id,email_norm,name,role,password_hash,created_at) VALUES ($1,$2,$3,$4,$5,$6,now())', [crypto.randomUUID(), clinicId, `${key.toLowerCase()}@x.test`, key, role, hash])
  for (const [k, c, r] of [['recA', A.clinicId, 'reception'], ['acctA', A.clinicId, 'accountant'], ['dentA', A.clinicId, 'dentist'], ['recB', B.clinicId, 'reception']] as const) await add(k, c, r)
  const emails: Record<string, string> = { ownerA: 'owner@a.test', ownerB: 'owner@b.test', recA: 'reca@x.test', acctA: 'accta@x.test', dentA: 'denta@x.test', recB: 'recb@x.test' }
  for (const [k, e] of Object.entries(emails)) cookies[k] = (await app.request('/v1/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ email: e, password: PW }) }, env)).headers.get('set-cookie')!.split(';')[0]
  const call = (who: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { ...H, cookie: cookies[who] }, body: body === undefined ? undefined : JSON.stringify(body) }, env)
  const raw = (who: string, method: string, path: string, body: BodyInit | undefined, headers: Record<string, string> = {}) => app.request(path, { method, headers: { origin: H.origin, 'x-dontalist-csrf': '1', cookie: cookies[who], ...headers }, body }, env)
  const json = async (r: Response) => (await r.json()) as any
  return { db, url, drop, app, A, B, call, raw, json, files }
}
