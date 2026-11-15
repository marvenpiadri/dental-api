import type { Bindings } from './env'

export type Config = {
  appOrigin: string
  apiOrigin: string
  corsOrigins: string[]
  cookie: { name: string; domain?: string; secure: boolean; sameSite: 'Strict' | 'Lax' | 'None' }
  session: { idleMs: number; absoluteMs: number }
}

const origin = (v: string | undefined, name: string): string => {
  let u: URL
  try { u = new URL(v ?? '') } catch { throw new Error(`${name} must be an absolute origin`) }
  if (u.origin === 'null' || u.pathname !== '/' ) throw new Error(`${name} must be an origin without a path`)
  return u.origin
}
const minutes = (v: string | undefined, dflt: number): number => {
  const n = v === undefined || v === '' ? dflt : Number(v)
  if (!Number.isInteger(n) || n < 1 || n > 60 * 24 * 30) throw new Error('invalid session duration')
  return n * 60_000
}

export function loadConfig(env: Bindings): Config {
  const appOrigin = origin(env.APP_ORIGIN, 'APP_ORIGIN')
  const apiOrigin = origin(env.API_ORIGIN, 'API_ORIGIN')
  const corsOrigins = (env.CORS_ORIGINS?.trim() ? env.CORS_ORIGINS.split(',') : [appOrigin]).map((o) => origin(o.trim(), 'CORS_ORIGINS'))
  const secure = env.COOKIE_SECURE !== 'false'
  const domain = env.COOKIE_DOMAIN?.trim() || undefined
  const name = env.COOKIE_NAME?.trim() || (secure && !domain ? '__Host-dl_session' : secure ? '__Secure-dl_session' : 'dl_session')
  if (name.startsWith('__Host-') && (!secure || domain)) throw new Error('__Host- cookies need Secure and no Domain')
  if (name.startsWith('__Secure-') && !secure) throw new Error('__Secure- cookies need Secure')
  const sameSite = env.COOKIE_SAMESITE ?? 'Lax'
  if (sameSite === 'None' && !secure) throw new Error('SameSite=None needs Secure')
  return {
    appOrigin, apiOrigin, corsOrigins,
    cookie: { name, domain, secure, sameSite },
    session: { idleMs: minutes(env.SESSION_IDLE_MINUTES, 120), absoluteMs: minutes(env.SESSION_ABSOLUTE_MINUTES, 720) },
  }
}
