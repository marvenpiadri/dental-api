// Shared API test setup on a real PostgreSQL: two clinics (A, B), staff with several roles, logged in.
import { createApp } from '../../src/app'
import { createClinic } from '../../src/admin/bootstrap'
import { hashPassword } from '../../src/auth/password'
import { testDb } from './db'
import type { FileStore } from '../../src/files/store'

/** In-memory FileStore (tier: unit-level fake; R2 itself is not exercised here). */
export function fakeStore() {
  const m = new Map<string, Uint8Array>()
  const store: FileStore = {
    put: async (k, body, size) => { const b = new Uint8Array(await new Response(body).arrayBuffer()); if (b.length !== size) throw new Error('length'); m.set(k, b) },
    get: async (k) => { const b = m.get(k); return b ? { body: new Response(b).body!, size: b.length } : null },
    delete: async (k) => { m.delete(k) },
  }
  return { store, m }
}

export const NOW = Date.parse('2026-11-16T07:00:00Z'), PW = 'correct horse battery'
const env = { PASSWORD_PEPPER: 'pepper', APP_ORIGIN: 'https://app.test', API_ORIGIN: 'https://api.test' }
const H = { origin: 'https://app.test', 'x-dontalist-csrf': '1', 'content-type': 'application/json' }

export async function harness() {
  const { db, drop } = await testDb(20)
  const files = fakeStore(), app = createApp({ db: () => db, now: () => NOW, files: () => files.store })
  const A = await createClinic(db, 'pepper', { clinicName: 'A', ownerEmail: 'owner@a.test', ownerName: 'OwnerA', password: PW }, NOW)
  const B = await createClinic(db, 'pepper', { clinicName: 'B', ownerEmail: 'owner@b.test', ownerName: 'OwnerB', password: PW }, NOW)
  const hash = await hashPassword(PW, 'pepper')
  const cookies: Record<string, string> = {}
  const add = async (key: string, clinicId: string, role: string) =>
    db.run('INSERT INTO staff (id,clinic_id,email_norm,name,role,password_hash,created_at) VALUES ($1,$2,$3,$4,$5,$6,now())', [crypto.randomUUID(), clinicId, `${key.toLowerCase()}@x.test`, key, role, hash])
  for (const [k, c, r] of [['recA', A.clinicId, 'reception'], ['acctA', A.clinicId, 'accountant'], ['dentA', A.clinicId, 'dentist'], ['recB', B.clinicId, 'reception']] as const) await add(k, c, r)
  const emails: Record<string, string> = { ownerA: 'owner@a.test', ownerB: 'owner@b.test', recA: 'reca@x.test', acctA: 'accta@x.test', dentA: 'denta@x.test', recB: 'recb@x.test' }
  for (const [k, e] of Object.entries(emails)) cookies[k] = (await app.request('/v1/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ email: e, password: PW }) }, env)).headers.get('set-cookie')!.split(';')[0]
  const call = (who: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { ...H, cookie: cookies[who] }, body: body === undefined ? undefined : JSON.stringify(body) }, env)
  const raw = (who: string, method: string, path: string, body: BodyInit | undefined, headers: Record<string, string> = {}) => app.request(path, { method, headers: { origin: H.origin, 'x-dontalist-csrf': '1', cookie: cookies[who], ...headers }, body }, env)
  const json = async (r: Response) => (await r.json()) as any
  return { db, drop, app, A, B, call, raw, json, files }
}
