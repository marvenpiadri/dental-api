import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { ApiError, fail } from '../http/errors'
import type { AppEnv } from '../http/context'
import { DuplicateKeyError, ExclusionError, type Db } from '../db/client'
import { isUuid, newId, sha256Hex } from '../lib/ids'
import { toDb } from '../lib/time'
import { parseLimit } from '../lib/pagination'
import { profileIn, settingsIn } from '../settings/routes'
import { createClinic } from './bootstrap'

/**
 * Operator console API: the owner of Dontalist creates clinic accounts and public profiles by hand and records subscriptions. Clients cannot sign up or subscribe themselves.
 * Guarded by the ADMIN_TOKEN secret (header x-dontalist-admin); without a 32+ character token the whole API answers 404.
 */
export const adminRoutes = new Hono<AppEnv>()
adminRoutes.onError((e, c) => { if (e instanceof ApiError) return fail(c, e); throw e })
adminRoutes.use('*', createMiddleware<AppEnv>(async (c, next) => {
  const t = c.env.ADMIN_TOKEN
  if (!t || t.length < 32) return fail(c, new ApiError(404, 'not_found', 'Not found'))
  const [a, b] = await Promise.all([sha256Hex(c.req.header('x-dontalist-admin') ?? ''), sha256Hex(t)])
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  if (diff) return fail(c, new ApiError(401, 'unauthenticated', 'Operator token required'))
  await next()
}))

const bad = (m = 'Invalid request') => new ApiError(400, 'bad_request', m)
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const body = async (c: { req: { json: () => Promise<unknown> } }) => { const b = await c.req.json().catch(() => null); if (!isRec(b)) throw bad(); return b }
const noExtra = (b: Record<string, unknown>, keys: string[]) => { for (const k of Object.keys(b)) if (!keys.includes(k)) throw bad(`Unknown field "${k}"`) }
const str = (v: unknown, max: number, required = false) => { if (v === undefined || v === null || v === '') { if (required) throw bad('Missing required field'); return undefined } if (typeof v !== 'string' || v.length > max) throw bad(); return v.trim() || undefined }
const day = (v: unknown) => { if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) throw bad('Dates must be YYYY-MM-DD'); return v }
function period(v: unknown) {
  if (!isRec(v)) throw bad('subscription is required'); noExtra(v, ['startsOn', 'endsOn', 'note'])
  const startsOn = day(v.startsOn), endsOn = day(v.endsOn)
  if (endsOn < startsOn) throw bad('The end date must not be before the start date')
  return { startsOn, endsOn, note: str(v.note, 500) }
}
const profile = (v: unknown) => {
  if (!isRec(v)) throw bad('profile is required')
  const p = profileIn(v)
  if (p.state === 'published' && !(p.slug && p.city && (p.countryCode || p.country))) throw bad('A published profile needs a country, a city and a web address (slug)')
  return p
}
const extras = (b: Record<string, unknown>) => settingsIn({ address: b.address, phone: b.phone }) // the public address and phone live in the settings document
const audit = (q: Db, clinicId: string, action: string, detail: object, now: Date) =>
  q.run('INSERT INTO audit_event (id, clinic_id, action, target_type, detail, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6)', [newId(), clinicId, action, 'clinic', JSON.stringify({ by: 'operator', ...detail }), now])
const taken = (q: Db, p: Record<string, unknown>, except?: string) =>
  q.rows('SELECT 1 FROM clinic_settings WHERE lower(profile ->> \'countryCode\') = lower($1) AND lower(profile ->> \'city\') = lower($2) AND profile ->> \'slug\' = $3 AND ($4::uuid IS NULL OR clinic_id <> $4) LIMIT 1', [p.countryCode ?? '', p.city ?? '', p.slug ?? '', except ?? null]).then((r) => r.length > 0)
const temporaryPassword = () => Array.from(crypto.getRandomValues(new Uint8Array(15)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('')
const statusOf = (s: string | null, e: string | null, today: string) => (!s || !e ? 'none' : s > today ? 'upcoming' : e < today ? 'expired' : 'active')

adminRoutes.post('/clinics', async (c) => {
  const b = await body(c); noExtra(b, ['clinicName', 'timezone', 'owner', 'profile', 'address', 'phone', 'subscription'])
  if (!isRec(b.owner)) throw bad('owner is required'); noExtra(b.owner, ['name', 'email'])
  const clinicName = str(b.clinicName, 200, true)!, ownerName = str(b.owner.name, 200, true)!, ownerEmail = str(b.owner.email, 254, true)!, tz = str(b.timezone, 64)
  if (tz) { try { new Intl.DateTimeFormat('en', { timeZone: tz }) } catch { throw bad('Unknown timezone') } }
  const p = profile(b.profile), s = extras(b), sub = period(b.subscription), now = c.get('now'), db = c.get('db'), pw = temporaryPassword()
  if (p.slug && await taken(db, p)) throw new ApiError(409, 'slug_taken', 'Another clinic already uses this address')
  try {
    const r = await createClinic(db, c.get('passwords'), { clinicName, ownerEmail, ownerName, password: pw, timezone: tz }, now, async (q, clinicId) => {
      await q.run('INSERT INTO clinic_settings (clinic_id, settings, settings_version, profile, profile_version, updated_at) VALUES ($1, $2::jsonb, 1, $3::jsonb, 1, $4)', [clinicId, JSON.stringify(s), JSON.stringify(p), toDb(now)])
      await q.run('INSERT INTO clinic_subscription (id, clinic_id, starts_on, ends_on, note, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [newId(), clinicId, sub.startsOn, sub.endsOn, sub.note ?? null, toDb(now)])
      await audit(q, clinicId, 'admin.clinic.created', { startsOn: sub.startsOn, endsOn: sub.endsOn }, toDb(now))
    })
    return c.json({ clinicId: r.clinicId, ownerEmail: ownerEmail.toLowerCase(), temporaryPassword: pw }, 201)
  } catch (e) {
    if (e instanceof Error && e.message === 'email already in use') throw new ApiError(409, 'email_taken', 'This email already has an account')
    if (e instanceof Error && e.message.startsWith('invalid')) throw bad(e.message === 'invalid email' ? 'Invalid email address' : 'Invalid name')
    if (e instanceof DuplicateKeyError) throw new ApiError(409, 'slug_taken', 'Another clinic already uses this address')
    throw e
  }
})

adminRoutes.get('/clinics', async (c) => {
  const q = c.req.query(), limit = parseLimit(q.limit), offset = q.offset === undefined ? 0 : /^\d{1,6}$/.test(q.offset) ? Number(q.offset) : -1
  if (limit === null || offset < 0 || (q.q ?? '').length > 80) throw bad()
  const today = new Date(c.get('now')).toISOString().slice(0, 10), term = q.q?.trim() || null, db = c.get('db')
  const where = `($1::text IS NULL OR strpos(lower(c.name || ' ' || coalesce(s.profile ->> 'city', '') || ' ' || coalesce(s.profile ->> 'slug', '')), lower($1)) > 0)`
  const [rows, [n]] = await Promise.all([
    db.rows<Record<string, string | null>>(`SELECT c.id, c.name, s.profile ->> 'city' AS city, s.profile ->> 'slug' AS slug, s.profile ->> 'state' AS state, o.email_norm AS owner_email, u.starts_on, u.ends_on
        FROM clinic c LEFT JOIN clinic_settings s ON s.clinic_id = c.id
        LEFT JOIN LATERAL (SELECT email_norm FROM staff WHERE clinic_id = c.id AND role = 'owner' ORDER BY created_at, id LIMIT 1) o ON true
        LEFT JOIN LATERAL (SELECT starts_on, ends_on FROM clinic_subscription WHERE clinic_id = c.id ORDER BY (daterange(starts_on, ends_on, '[]') @> $2::date) DESC, ends_on DESC LIMIT 1) u ON true
       WHERE ${where} ORDER BY lower(c.name), c.id LIMIT $3 OFFSET $4`, [term, today, limit, offset]),
    db.rows<{ n: string }>(`SELECT count(*) AS n FROM clinic c LEFT JOIN clinic_settings s ON s.clinic_id = c.id WHERE ${where}`, [term]),
  ])
  return c.json({ total: Number(n.n), offset, limit, items: rows.map((r) => ({ id: r.id, name: r.name, city: r.city, slug: r.slug, state: r.state ?? 'draft', ownerEmail: r.owner_email, startsOn: r.starts_on, endsOn: r.ends_on, subscription: statusOf(r.starts_on, r.ends_on, today) })) })
})

adminRoutes.get('/clinics/:id', async (c) => {
  const id = c.req.param('id'); if (!isUuid(id)) throw new ApiError(404, 'not_found', 'Not found')
  const db = c.get('db'), [r] = await db.rows<Record<string, unknown>>(`SELECT c.id, c.name, c.timezone, s.profile, s.profile_version, s.settings ->> 'address' AS address, s.settings ->> 'phone' AS phone,
      (SELECT email_norm FROM staff WHERE clinic_id = c.id AND role = 'owner' ORDER BY created_at, id LIMIT 1) AS owner_email
    FROM clinic c LEFT JOIN clinic_settings s ON s.clinic_id = c.id WHERE c.id = $1`, [id])
  if (!r) throw new ApiError(404, 'not_found', 'Not found')
  const subs = await db.rows('SELECT id, starts_on AS "startsOn", ends_on AS "endsOn", note FROM clinic_subscription WHERE clinic_id = $1 ORDER BY starts_on DESC LIMIT 50', [id])
  return c.json({ id: r.id, name: r.name, timezone: r.timezone, ownerEmail: r.owner_email, address: r.address, phone: r.phone, profile: r.profile && Object.keys(r.profile as object).length ? r.profile : null, version: r.profile_version ?? 0, subscriptions: subs })
})

adminRoutes.put('/clinics/:id', async (c) => {
  const id = c.req.param('id'); if (!isUuid(id)) throw new ApiError(404, 'not_found', 'Not found')
  const b = await body(c); noExtra(b, ['expectedVersion', 'clinicName', 'profile', 'address', 'phone'])
  if (!Number.isInteger(b.expectedVersion) || (b.expectedVersion as number) < 0) throw bad('expectedVersion must be an integer')
  const name = str(b.clinicName, 200), p = profile(b.profile), s = extras(b), now = toDb(c.get('now'))
  if (p.slug && await taken(c.get('db'), p, id)) throw new ApiError(409, 'slug_taken', 'Another clinic already uses this address')
  const v = await c.get('db').tx(async (q) => {
    const [cl] = await q.rows('SELECT 1 FROM clinic WHERE id = $1', [id]); if (!cl) throw new ApiError(404, 'not_found', 'Not found')
    await q.run('INSERT INTO clinic_settings (clinic_id, updated_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, now])
    const [r] = await q.rows<{ profile_version: number }>('SELECT profile_version FROM clinic_settings WHERE clinic_id = $1 FOR UPDATE', [id])
    if (r.profile_version !== b.expectedVersion) throw new ApiError(409, 'stale', 'The profile changed; reload and try again')
    if (name) await q.run('UPDATE clinic SET name = $1 WHERE id = $2', [name, id])
    await q.run('UPDATE clinic_settings SET profile = $1::jsonb, profile_version = profile_version + 1, settings = settings || $2::jsonb, settings_version = settings_version + 1, updated_at = $3 WHERE clinic_id = $4', [JSON.stringify(p), JSON.stringify(s), now, id])
    await audit(q, id, 'admin.profile.updated', { state: p.state }, now)
    return r.profile_version + 1
  }).catch((e) => { throw e instanceof DuplicateKeyError ? new ApiError(409, 'slug_taken', 'Another clinic already uses this address') : e })
  return c.json({ version: v })
})

adminRoutes.post('/clinics/:id/subscriptions', async (c) => {
  const id = c.req.param('id'); if (!isUuid(id)) throw new ApiError(404, 'not_found', 'Not found')
  const sub = period(await body(c)), now = toDb(c.get('now')), sid = newId()
  await c.get('db').tx(async (q) => {
    const [cl] = await q.rows('SELECT 1 FROM clinic WHERE id = $1', [id]); if (!cl) throw new ApiError(404, 'not_found', 'Not found')
    await q.run('INSERT INTO clinic_subscription (id, clinic_id, starts_on, ends_on, note, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [sid, id, sub.startsOn, sub.endsOn, sub.note ?? null, now])
    await audit(q, id, 'admin.subscription.added', { startsOn: sub.startsOn, endsOn: sub.endsOn }, now)
  }).catch((e) => { throw e instanceof ExclusionError ? new ApiError(409, 'overlap', 'This period overlaps an existing one') : e })
  return c.json({ id: sid }, 201)
})

adminRoutes.delete('/clinics/:id/subscriptions/:sid', async (c) => {
  const id = c.req.param('id'), sid = c.req.param('sid'); if (!isUuid(id) || !isUuid(sid)) throw new ApiError(404, 'not_found', 'Not found')
  const now = toDb(c.get('now'))
  await c.get('db').tx(async (q) => {
    const gone = await q.rows('DELETE FROM clinic_subscription WHERE id = $1 AND clinic_id = $2 RETURNING id', [sid, id]); if (!gone.length) throw new ApiError(404, 'not_found', 'Not found')
    await audit(q, id, 'admin.subscription.removed', {}, now)
  })
  return c.body(null, 204)
})
