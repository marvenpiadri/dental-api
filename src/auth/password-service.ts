import { ApiError } from '../http/errors'

/**
 * Password hashing is behind this interface so it can live anywhere. TODAY it is a separate Neon Function (docs/password-service.md) because the
 * Cloudflare free plan allows 10 ms of CPU per request, far too little for a safe hash. To bring hashing back into the Worker after upgrading,
 * write another implementation of these two methods (Argon2id with the same `$argon2id$` strings keeps every stored hash valid) and pass it as
 * `passwords` in createApp; nothing else changes.
 */
export interface PasswordService {
  /** A new self-describing Argon2id hash (PHC string) with its own random salt. */
  hash(password: string): Promise<string>
  /** True only when the password matches. Throws ApiError 503 when the service cannot answer: callers must NOT treat that as a wrong password. */
  verify(password: string, hash: string): Promise<boolean>
}

const unavailable = () => new ApiError(503, 'password_service_unavailable', 'Sign-in is temporarily unavailable. Try again shortly.')
/** Used when no service is configured: everything fails closed. */
export const unconfiguredPasswords: PasswordService = { hash: async () => { throw unavailable() }, verify: async () => { throw unavailable() } }

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')

export function httpPasswordService(o: { url?: string; secret?: string; timeoutMs?: number; fetch?: typeof fetch; now?: () => number }): PasswordService {
  if (!o.url || !o.secret || o.secret.length < 32) return unconfiguredPasswords
  const base = o.url.replace(/\/+$/, ''), f = o.fetch ?? fetch, now = o.now ?? Date.now
  const key = crypto.subtle.importKey('raw', new TextEncoder().encode(o.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  async function call(path: '/hash' | '/verify', payload: object): Promise<Record<string, unknown>> {
    const body = JSON.stringify(payload), ts = String(now())
    const sig = hex(await crypto.subtle.sign('HMAC', await key, new TextEncoder().encode(`${ts}.POST.${path}.${body}`)))
    let res: Response
    try {
      res = await f(`${base}${path}`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-dl-timestamp': ts, 'x-dl-signature': sig }, signal: AbortSignal.timeout(o.timeoutMs ?? 5000) })
    } catch { throw unavailable() } // timeout, DNS, TLS, connection reset: the service is not answering
    if (!res.ok) { console.error('password service answered', res.status); throw unavailable() } // status only: never the body
    try { return (await res.json()) as Record<string, unknown> } catch { throw unavailable() }
  }
  return {
    async hash(password) {
      const r = await call('/hash', { password })
      if (typeof r.hash !== 'string' || !r.hash.startsWith('$argon2id$')) throw unavailable()
      return r.hash
    },
    async verify(password, hash) {
      const r = await call('/verify', { password, hash })
      if (typeof r.valid !== 'boolean') throw unavailable()
      return r.valid
    },
  }
}
