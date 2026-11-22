/**
 * Password hashing service (TEMPORARY, see ../docs/password-service.md). It does exactly two things: hash a password, verify a password against a hash.
 * It knows nothing about users, sessions, permissions or clinics, never reads the database, and never logs a request.
 * Argon2id comes from hash-wasm (output is the standard PHC string `$argon2id$v=19$m=…,t=…,p=…$salt$hash`); no cryptography is written here.
 * The only caller is our API. Every request carries an HMAC of (timestamp, method, path, body) made with a shared secret; anything else gets 401.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import argon from 'hash-wasm/dist/argon2.umd.min.js' // the documented single-algorithm build (30 KB instead of 216 KB); a CommonJS bundle, hence the default import
const { argon2id, argon2Verify } = argon

// OWASP-recommended Argon2id setting: 19 MiB, 2 passes, 1 lane. Raise memory/iterations here only; stored hashes carry their own parameters.
export const ARGON2 = { memorySize: 19456, iterations: 2, parallelism: 1, hashLength: 32 } as const
const MAX_BODY = 2048, MAX_PASSWORD = 512, MAX_HASH = 300, SKEW_MS = 30_000, MAX_IN_FLIGHT = 8

type Env = { HASH_SECRET?: string }
const json = (status: number, body: object, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } })
const deny = () => json(401, { error: 'unauthorized' }) // one answer for every authentication failure
const bad = () => json(400, { error: 'invalid_request' })

const seen = new Map<string, number>() // signatures already used inside the skew window (per instance: a replay only recomputes a hash, it reveals nothing)
let inFlight = 0

async function readCapped(req: Request): Promise<string | null> {
  const len = Number(req.headers.get('content-length') ?? 0)
  if (len > MAX_BODY || !req.body) return len > MAX_BODY ? null : ''
  const reader = req.body.getReader(), parts: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read(); if (done) break
    n += value.length; if (n > MAX_BODY) { await reader.cancel(); return null }
    parts.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(parts))
}

export async function handle(req: Request, env: Env, now = Date.now()): Promise<Response> {
  const secret = env.HASH_SECRET
  if (!secret || secret.length < 32) return json(503, { error: 'unavailable' }) // not configured: fail closed
  const url = new URL(req.url)
  if (req.method !== 'POST' || (url.pathname !== '/hash' && url.pathname !== '/verify')) return json(404, { error: 'not_found' })

  const body = await readCapped(req)
  if (body === null) return json(413, { error: 'too_large' })
  const ts = Number(req.headers.get('x-dl-timestamp')), sig = req.headers.get('x-dl-signature') ?? ''
  if (!Number.isFinite(ts) || Math.abs(now - ts) > SKEW_MS || !/^[0-9a-f]{64}$/.test(sig)) return deny()
  const want = createHmac('sha256', secret).update(`${ts}.${req.method}.${url.pathname}.${body}`).digest()
  if (!timingSafeEqual(want, Buffer.from(sig, 'hex'))) return deny()
  for (const [s, t] of seen) if (now - t > SKEW_MS * 2) seen.delete(s)
  if (seen.has(sig)) return deny()
  seen.set(sig, now)

  let b: { password?: unknown; hash?: unknown }
  try { b = JSON.parse(body) } catch { return bad() }
  if (!b || typeof b !== 'object' || typeof b.password !== 'string' || !b.password.length || b.password.length > MAX_PASSWORD) return bad()
  if (inFlight >= MAX_IN_FLIGHT) return json(503, { error: 'busy' }, { 'retry-after': '1' })
  inFlight++
  try {
    const password = b.password.normalize('NFKC') // one canonical form, so the same password typed on different devices matches
    if (url.pathname === '/hash') {
      const salt = crypto.getRandomValues(new Uint8Array(16))
      return json(200, { hash: await argon2id({ ...ARGON2, password, salt, outputType: 'encoded' }) })
    }
    if (typeof b.hash !== 'string' || b.hash.length > MAX_HASH) return bad()
    let valid = false
    try { valid = b.hash.startsWith('$argon2id$') && (await argon2Verify({ password, hash: b.hash })) } catch { valid = false } // malformed hash: not valid, not an error
    return json(200, { valid })
  } catch {
    return json(500, { error: 'internal' }) // nothing about the request or the failure is returned or logged
  } finally { inFlight-- }
}

// Neon Functions: a module whose default export has fetch(request) -> Response.
export default { fetch: (req: Request) => handle(req, process.env) }
