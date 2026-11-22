import type { PasswordService } from './password-service'

export const validPassword = (p: string) => p.length >= 12 && p.length <= 200

/**
 * LEGACY hashes only. Before the password service, passwords were stored as `pbkdf2$<iterations>x<rounds>$<salt>$<hash>`: PBKDF2-HMAC-SHA256 over
 * HMAC(pepper, NFKC(password)). They still verify here, and the login that proves a password upgrades its hash to Argon2id (see auth/routes.ts).
 * No new legacy hash is ever created. Delete this verifier (and PASSWORD_PEPPER) once no `pbkdf2$` rows remain:
 *   SELECT count(*) FROM staff WHERE password_hash LIKE 'pbkdf2$%';
 */
const enc = new TextEncoder()
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const safeEqual = (a: string, b: string) => {
  const x = enc.encode(a), y = enc.encode(b)
  let d = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return d === 0
}
export const isLegacyHash = (stored: string) => stored.startsWith('pbkdf2$')

async function verifyLegacy(password: string, stored: string, pepper: string): Promise<boolean> {
  const [, cost, salt, hash] = stored.split('$'), m = /^(\d{1,7})x(\d{1,3})$/.exec(cost ?? '')
  if (!m || !salt || !hash || +m[1] > 1_000_000 || +m[2] > 50) return false
  const mac = await crypto.subtle.importKey('raw', enc.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  let secret = new Uint8Array(await crypto.subtle.sign('HMAC', mac, enc.encode(password.normalize('NFKC'))))
  for (let r = 0; r < +m[2]; r++) {
    const key = await crypto.subtle.importKey('raw', secret, 'PBKDF2', false, ['deriveBits'])
    secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt) as BufferSource, iterations: +m[1] }, key, 256))
  }
  return safeEqual(b64(secret), hash)
}

/** The one place a stored hash is checked: legacy PBKDF2 here, everything else (Argon2id) by the password service. `upgrade` = re-hash after login. */
export async function verifyStored(passwords: PasswordService, password: string, stored: string, pepper?: string): Promise<{ ok: boolean; upgrade: boolean }> {
  if (isLegacyHash(stored)) return { ok: !!pepper && (await verifyLegacy(password, stored, pepper)), upgrade: true }
  return { ok: await passwords.verify(password, stored), upgrade: false }
}

/** A real Argon2id hash of a random password nobody knows. Verified for unknown e-mails so a login costs the same whether or not the account exists. */
export const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$1CtQH5kv9HgiEqh7JwH11A$SjMePThevryjIHjOL3CAoWSGWdxQEaXZ791+2dEl1To'
