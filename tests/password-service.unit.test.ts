// UNIT tier (no database): the deployed password-service handler, real Argon2id, real HMAC check.
import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { handle, ARGON2 } from '../password-service/src/handler'

const SECRET = 'unit-secret-unit-secret-unit-secret-01'
const NOW = 1_800_000_000_000
const call = (path: string, body: unknown, o: { secret?: string; ts?: number; method?: string; raw?: string; sig?: string; env?: { HASH_SECRET?: string } } = {}) => {
  const text = o.raw ?? JSON.stringify(body), ts = o.ts ?? NOW, method = o.method ?? 'POST'
  const sig = o.sig ?? createHmac('sha256', o.secret ?? SECRET).update(`${ts}.${method}.${path}.${text}`).digest('hex')
  return handle(new Request(`https://svc.test${path}`, { method, body: method === 'POST' ? text : undefined, headers: { 'x-dl-timestamp': String(ts), 'x-dl-signature': sig, 'content-type': 'application/json' } }), o.env ?? { HASH_SECRET: SECRET }, NOW)
}
const hashOf = async (password: string) => ((await (await call('/hash', { password })).json()) as any).hash as string

describe('password service', () => {
  it('hashes to a standard Argon2id PHC string with the configured parameters and a random salt', async () => {
    const a = await hashOf('correct horse battery'), b = await hashOf('correct horse battery')
    expect(a).toMatch(new RegExp(`^\\$argon2id\\$v=19\\$m=${ARGON2.memorySize},t=${ARGON2.iterations},p=${ARGON2.parallelism}\\$`)); expect(a).not.toBe(b); expect(a).not.toContain('correct')
  })
  it('verifies right and wrong passwords; NFKC makes equivalent spellings match', async () => {
    const h = await hashOf('café password!')
    const v = async (password: string, hash = h) => ((await (await call('/verify', { password, hash })).json()) as any).valid
    expect(await v('café password!')).toBe(true); expect(await v('café password!')).toBe(true); expect(await v('cafe password!')).toBe(false)
  })
  it('treats malformed or foreign hashes as "not valid", never an error', async () => {
    for (const hash of ['', 'garbage', '$argon2id$broken', 'pbkdf2$1000x2$AA$AA', '$2b$10$abcdefghijklmnopqrstuuAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']) {
      const r = await call('/verify', { password: 'x', hash }); expect(r.status).toBe(200); expect(((await r.json()) as any).valid).toBe(false)
    }
  })
  it('rejects missing, wrong, stale, future, malformed and reused signatures with one identical 401', async () => {
    const body = { password: 'pw-pw-pw-pw' }
    const cases = [call('/hash', body, { secret: 'another-secret-another-secret-another!' }), call('/hash', body, { ts: NOW - 31_000 }), call('/hash', body, { ts: NOW + 31_000 }), call('/hash', body, { sig: 'zz' }), call('/hash', body, { sig: '0'.repeat(64) })]
    for (const r of await Promise.all(cases)) { expect(r.status).toBe(401); expect(await r.json()).toEqual({ error: 'unauthorized' }) }
    const text = JSON.stringify({ password: 'replayed-pw-1' }), once = await call('/hash', null, { raw: text }), twice = await call('/hash', null, { raw: text })
    expect(once.status).toBe(200); expect(twice.status).toBe(401)
  })
  it('a signature is bound to the path and the body', async () => {
    const text = JSON.stringify({ password: 'bound-pw-1', hash: 'x' }), sig = createHmac('sha256', SECRET).update(`${NOW}.POST./hash.${text}`).digest('hex')
    expect((await call('/verify', null, { raw: text, sig })).status).toBe(401)
    expect((await call('/hash', null, { raw: text.replace('bound', 'other'), sig })).status).toBe(401)
  })
  it('only POST /hash and POST /verify exist', async () => {
    expect((await call('/hash', null, { method: 'GET' })).status).toBe(404); expect((await call('/admin', {})).status).toBe(404); expect((await call('/', {})).status).toBe(404)
  })
  it('validates input: bad JSON, wrong types, empty and over-long passwords, oversized bodies', async () => {
    expect((await call('/hash', null, { raw: '{nope' })).status).toBe(400)
    for (const b of [{}, { password: 5 }, { password: '' }, { password: 'x'.repeat(513) }, []]) expect((await call('/hash', b)).status, JSON.stringify(b).slice(0, 30)).toBe(400)
    expect((await call('/verify', { password: 'x' })).status).toBe(400); expect((await call('/verify', { password: 'x', hash: 'h'.repeat(301) })).status).toBe(400)
    expect((await call('/hash', { password: 'x'.repeat(3000) })).status).toBe(413)
    expect((await call('/hash', { password: 'x'.repeat(512) })).status).toBe(200) // the limit itself is allowed, not silently truncated
  })
  it('fails closed when the secret is missing or too short', async () => {
    for (const env of [{}, { HASH_SECRET: 'short' }]) expect((await call('/hash', { password: 'pw-pw-pw-pw' }, { env })).status).toBe(503)
  })
  it('never echoes the password or hash in any answer', async () => {
    const pw = 'very-secret-pw-1234'; const h = await hashOf(pw)
    for (const r of [await call('/verify', { password: pw, hash: h }), await call('/verify', { password: pw, hash: 'junk' }), await call('/hash', { password: pw })]) expect(await r.text()).not.toContain(pw)
  })
})
