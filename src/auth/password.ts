/**
 * PBKDF2-HMAC-SHA256 over HMAC(pepper, NFKC(password)).
 * Stored as `pbkdf2$<iterations>x<rounds>$<salt>$<hash>`. Cost = iterations × rounds.
 * Why rounds: Cloudflare has historically capped one deriveBits call at 100,000 iterations (local workerd accepts 600,000, a deployed Worker is
 * unverified). Chaining 6 × 100,000 gives OWASP's 600,000-iteration cost either way. Raise `rounds` or switch algorithm later: needsRehash()
 * tells the login flow to re-store the hash.
 */
const enc = new TextEncoder()
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

export const PASSWORD_PARAMS = { iterations: 100_000, rounds: 6 }
export const validPassword = (p: string) => p.length >= 12 && p.length <= 200

export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b)
  let d = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return d === 0
}

async function derive(password: string, pepper: string, salt: Uint8Array, iterations: number, rounds: number): Promise<string> {
  const mac = await crypto.subtle.importKey('raw', enc.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  let secret = new Uint8Array(await crypto.subtle.sign('HMAC', mac, enc.encode(password.normalize('NFKC'))))
  for (let r = 0; r < rounds; r++) {
    const key = await crypto.subtle.importKey('raw', secret, 'PBKDF2', false, ['deriveBits'])
    secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256))
  }
  return b64(secret)
}

export async function hashPassword(password: string, pepper: string, p = PASSWORD_PARAMS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return `pbkdf2$${p.iterations}x${p.rounds}$${b64(salt)}$${await derive(password, pepper, salt, p.iterations, p.rounds)}`
}

const parse = (stored: string) => {
  const [algo, cost, salt, hash] = stored.split('$')
  const m = /^(\d{1,7})x(\d{1,3})$/.exec(cost ?? '')
  if (algo !== 'pbkdf2' || !m || !salt || !hash) return null
  return { iterations: +m[1], rounds: +m[2], salt, hash }
}

export async function verifyPassword(password: string, stored: string, pepper: string): Promise<boolean> {
  const s = parse(stored)
  if (!s || s.iterations > 1_000_000 || s.rounds > 50) return false
  return safeEqual(await derive(password, pepper, unb64(s.salt), s.iterations, s.rounds), s.hash)
}

export const needsRehash = (stored: string, p = PASSWORD_PARAMS): boolean => {
  const s = parse(stored)
  return !s || s.iterations * s.rounds < p.iterations * p.rounds
}

/** Verified against for unknown accounts so timing does not reveal which e-mails exist. */
export const dummyHash = (p = PASSWORD_PARAMS) => `pbkdf2$${p.iterations}x${p.rounds}$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`
