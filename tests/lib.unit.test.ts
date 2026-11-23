import { describe, expect, it } from 'vitest'
import { isUuid, newId } from '../src/lib/ids'
import { verifyStored, isLegacyHash, DUMMY_HASH } from '../src/auth/password'
import type { PasswordService } from '../src/auth/password-service'
import { formatMoney, parseMoney, percentOf, sum, toWholeUnits } from '../src/lib/money'
import { decodeCursor, encodeCursor, page, parseLimit } from '../src/lib/pagination'
import { limitStream, PayloadTooLargeError } from '../src/lib/stream-limit'
import { loadConfig } from '../src/config'
import { can, effective, defaultsOf } from '../src/auth/permissions'

// A hash made by the pre-service implementation (PBKDF2 over HMAC(pepper, password), 1000x2 so the test is fast). Password "correct horse battery", pepper "pepper".
const LEGACY = 'pbkdf2$1000x2$dIpvPhGsxX28kUECQRjO2A$jLx_8DG2DyF38xGgik33ihW6qMIG_fMEQBLsHrzouKc'
const noService: PasswordService = { hash: async () => { throw new Error('must not be called') }, verify: async () => { throw new Error('must not be called') } }
describe('legacy password verification', () => {
  it('still verifies old PBKDF2 hashes without the service, and asks for an upgrade', async () => {
    expect(isLegacyHash(LEGACY)).toBe(true); expect(isLegacyHash(DUMMY_HASH)).toBe(false)
    expect(await verifyStored(noService, 'correct horse battery', LEGACY, 'pepper')).toEqual({ ok: true, upgrade: true })
    expect(await verifyStored(noService, 'correct horse batterz', LEGACY, 'pepper')).toEqual({ ok: false, upgrade: true })
    expect((await verifyStored(noService, 'correct horse battery', LEGACY, 'other-pepper')).ok).toBe(false)
    expect((await verifyStored(noService, 'correct horse battery', LEGACY, undefined)).ok).toBe(false) // no pepper configured: cannot verify, never "true"
  })
  it('rejects malformed or absurd legacy hashes', async () => {
    for (const s of ['pbkdf2$1x1$a', 'pbkdf2$99999999x1$AA$AA', 'pbkdf2$1000x99$AA$AA', 'pbkdf2$', 'pbkdf2$abc$AA$AA']) expect((await verifyStored(noService, 'x', s, 'p')).ok, s).toBe(false)
  })
  it('sends everything else to the service', async () => {
    const seen: string[][] = []
    const svc: PasswordService = { hash: async () => '', verify: async (p, h) => { seen.push([p, h]); return true } }
    expect(await verifyStored(svc, 'pw', '$argon2id$x')).toEqual({ ok: true, upgrade: false }); expect(seen).toEqual([['pw', '$argon2id$x']])
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
  const e = { PASSWORD_PEPPER: 'p', APP_ORIGIN: 'https://dontalist.com', API_ORIGIN: 'https://api.dontalist.com' }
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
describe('newId (UUIDv7)', () => {
  it('is a valid v7 uuid, unique, and sorts by creation time even within one millisecond', () => {
    const ids = Array.from({ length: 5000 }, () => newId())
    for (const id of ids.slice(0, 50)) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(new Set(ids).size).toBe(5000)
    expect([...ids].sort()).toEqual(ids)
    expect(isUuid(ids[0])).toBe(true)
  })
  it('embeds the creation time', () => {
    const t = Date.now(), id = newId()
    expect(Math.abs(parseInt(id.replace(/-/g, '').slice(0, 12), 16) - t)).toBeLessThan(2000)
  })
})
