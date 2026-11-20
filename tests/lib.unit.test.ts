import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword, needsRehash } from '../src/auth/password'
import { formatMoney, parseMoney, percentOf, sum, toWholeUnits } from '../src/lib/money'
import { decodeCursor, encodeCursor, page, parseLimit } from '../src/lib/pagination'
import { limitStream, PayloadTooLargeError } from '../src/lib/stream-limit'
import { loadConfig } from '../src/config'
import { can, effective, defaultsOf } from '../src/auth/permissions'

describe('password', () => {
  it('verifies, rejects wrong, and flags weaker stored costs for rehash', async () => {
    const h = await hashPassword('correct horse battery', 'pep', { iterations: 1000, rounds: 2 })
    expect(await verifyPassword('correct horse battery', h, 'pep')).toBe(true)
    expect(await verifyPassword('correct horse batterz', h, 'pep')).toBe(false)
    expect(await verifyPassword('correct horse battery', h, 'other-pepper')).toBe(false)
    expect(needsRehash(h)).toBe(true)
    expect(needsRehash(await hashPassword('x', 'pep', { iterations: 100_000, rounds: 6 }))).toBe(false)
  })
  it('rejects malformed or absurd stored hashes', async () => {
    for (const s of ['', 'plain', 'pbkdf2$1x1$a', 'pbkdf2$99999999x1$AA$AA']) expect(await verifyPassword('x', s, 'p')).toBe(false)
  })
})
describe('money (no floats)', () => {
  it('round-trips and sums exactly', () => {
    expect(formatMoney(parseMoney('0.10') + parseMoney('0.20'))).toBe('0.30')
    expect(formatMoney(sum(Array.from({ length: 1000 }, () => parseMoney('0.01'))))).toBe('10.00')
    expect(formatMoney(parseMoney('-12.5'))).toBe('-12.50')
  })
  it('rounds percent half-up on magnitude, symmetric for credit notes', () => {
    expect(formatMoney(percentOf(parseMoney('0.05'), 1000))).toBe('0.01')
    expect(formatMoney(percentOf(parseMoney('-0.05'), 1000))).toBe('-0.01')
    expect(formatMoney(percentOf(parseMoney('1000.00'), 2000))).toBe('200.00')
  })
  it('refuses silent rounding to whole units and bad input', () => {
    expect(toWholeUnits(parseMoney('300.00'))).toBe(300)
    expect(() => toWholeUnits(parseMoney('300.50'))).toThrow()
    for (const s of ['1e3', '1,5', '', '1.234', 'abc']) expect(() => parseMoney(s)).toThrow()
  })
})
describe('pagination', () => {
  it('defaults 25, caps 100, rejects invalid', () => {
    expect(parseLimit(undefined)).toBe(25); expect(parseLimit('100')).toBe(100)
    for (const v of ['0', '101', '-1', '1.5', 'abc', '99999']) expect(parseLimit(v)).toBeNull()
  })
  it('cursor round-trips and rejects garbage', () => {
    expect(decodeCursor(encodeCursor('2026-01-01', 'id1'))).toEqual(['2026-01-01', 'id1'])
    expect(decodeCursor('not-base64!!')).toBeNull(); expect(decodeCursor(undefined)).toBeUndefined()
  })
  it('knows a next page from limit+1 rows', () => {
    expect(page([1, 2, 3], 2, String).nextCursor).toBe('2'); expect(page([1, 2], 2, String).nextCursor).toBeNull()
  })
})
describe('stream limit', () => {
  const run = async (chunks: number[], max: number) => {
    const { stream } = limitStream(max)
    const src = new ReadableStream({ start(c) { for (const n of chunks) c.enqueue(new Uint8Array(n)); c.close() } })
    return new Response(src.pipeThrough(stream)).arrayBuffer()
  }
  it('passes within the limit and errors past it, whatever Content-Length said', async () => {
    expect((await run([5, 5], 10)).byteLength).toBe(10)
    await expect(run([5, 6], 10)).rejects.toBeInstanceOf(PayloadTooLargeError)
  })
})
describe('config', () => {
  const e = { TIDB_DATABASE_URL: 'x', PASSWORD_PEPPER: 'p', APP_ORIGIN: 'https://dontalist.com', API_ORIGIN: 'https://api.dontalist.com' }
  it('defaults to host-only __Host- cookie and APP_ORIGIN for CORS', () => {
    const c = loadConfig(e); expect(c.cookie.name).toBe('__Host-dl_session'); expect(c.cookie.domain).toBeUndefined(); expect(c.corsOrigins).toEqual(['https://dontalist.com'])
  })
  it('a domain change is configuration only', () => {
    const c = loadConfig({ ...e, APP_ORIGIN: 'https://clinic.dontalist.com', CORS_ORIGINS: 'https://clinic.dontalist.com' }); expect(c.appOrigin).toBe('https://clinic.dontalist.com')
  })
  it('rejects unsafe combinations and bad origins', () => {
    expect(() => loadConfig({ ...e, COOKIE_DOMAIN: 'dontalist.com', COOKIE_NAME: '__Host-x' })).toThrow()
    expect(() => loadConfig({ ...e, APP_ORIGIN: 'https://x.com/path' })).toThrow()
    expect(() => loadConfig({ ...e, COOKIE_SAMESITE: 'None', COOKIE_SECURE: 'false' })).toThrow()
  })
})
describe('permissions', () => {
  it('owner-only permissions cannot be delegated and removals apply', () => {
    expect(can({ role: 'reception', extra: ['profile.edit'] }, 'profile.edit')).toBe(false)
    expect(can({ role: 'reception', removed: ['appointments.create'] }, 'appointments.create')).toBe(false)
    expect(effective({ role: 'owner' }).size).toBe(defaultsOf('owner').length)
    expect(can({ role: 'accountant' }, 'clinical.view')).toBe(false)
  })
})
