import { Hono } from 'hono'
import { ApiError, fail } from '../http/errors'
import { authenticate, requires } from '../http/middleware'
import type { AppEnv } from '../http/context'
import { isUuid, newId } from '../lib/ids'
import { toDb } from '../lib/time'
import { formatMoney, parseMoney } from '../lib/money'

/** Clinic identity and finance settings, the public profile, closures and the price list. Everyone signed in can read (the app needs currency, hours, prices); changing needs settings.edit (profile: the owner). */
export const settingsRoutes = new Hono<AppEnv>()
settingsRoutes.use('*', authenticate)
settingsRoutes.onError((e, c) => { if (e instanceof ApiError) return fail(c, e); throw e })
const bad = (m = 'Invalid request') => new ApiError(400, 'bad_request', m)
const notFound = () => new ApiError(404, 'not_found', 'Not found')
const body = async (c: { req: { json: () => Promise<unknown> } }) => { const b = await c.req.json().catch(() => null); if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad(); return b as Record<string, unknown> }
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown, max: number): string | undefined => { if (v === undefined || v === null || v === '') return undefined; if (typeof v !== 'string' || v.length > max) throw bad(); return v.trim() || undefined }
const list = <T>(v: unknown, max: number, one: (x: unknown) => T): T[] | undefined => { if (v === undefined) return undefined; if (!Array.isArray(v) || v.length > max) throw bad(); return v.map(one) }
const imageUrl = (v: unknown, max: number) => { const s = text(v, max); if (s && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s)) throw bad('Images must be PNG, JPEG or WebP'); return s }
const day = (v: unknown) => { if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) throw bad('Dates must be YYYY-MM-DD'); return v }
const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
const noExtra = (b: Record<string, unknown>, keys: readonly string[]) => { for (const k of Object.keys(b)) if (!keys.includes(k)) throw bad(`Unknown field "${k}"`) }

const SETTINGS_KEYS = ['legalName', 'taxId', 'bank', 'invoiceNote', 'paymentDays', 'address', 'phone', 'email', 'website', 'countryCode', 'city', 'postalCode', 'hours', 'payerTypes', 'payers', 'customProviders', 'logo'] as const
function settingsIn(b: Record<string, unknown>) {
  noExtra(b, SETTINGS_KEYS)
  const pd = b.paymentDays; if (pd !== undefined && (!Number.isInteger(pd) || (pd as number) < 0 || (pd as number) > 365)) throw bad('paymentDays must be 0-365')
  const cc = text(b.countryCode, 2); if (cc && !/^[A-Z]{2}$/.test(cc)) throw bad('countryCode must be ISO 3166-1 alpha-2')
  if (b.hours !== undefined && (!isRec(b.hours) || JSON.stringify(b.hours).length > 4000)) throw bad('Invalid hours')
  return clean({ legalName: text(b.legalName, 200), taxId: text(b.taxId, 60), bank: text(b.bank, 300), invoiceNote: text(b.invoiceNote, 500), paymentDays: pd, address: text(b.address, 300), phone: text(b.phone, 40), email: text(b.email, 254),
    website: text(b.website, 200), countryCode: cc, city: text(b.city, 100), postalCode: text(b.postalCode, 20), hours: b.hours,
    payerTypes: list(b.payerTypes, 10, (x) => { if (typeof x !== 'string' || x.length > 20) throw bad(); return x }),
    payers: list(b.payers, 200, (x) => { if (!isRec(x)) throw bad(); noExtra(x, ['id', 'type', 'name', 'hidden']); return clean({ id: text(x.id, 60) ?? (() => { throw bad() })(), type: text(x.type, 20) ?? (() => { throw bad() })(), name: text(x.name, 120) ?? (() => { throw bad() })(), hidden: x.hidden === true ? true : undefined }) }),
    customProviders: list(b.customProviders, 200, (x) => { if (!isRec(x)) throw bad(); noExtra(x, ['id', 'name', 'short', 'kind', 'aliases', 'custom']); return clean({ id: text(x.id, 60) ?? (() => { throw bad() })(), name: text(x.name, 120) ?? (() => { throw bad() })(), short: text(x.short, 30), kind: text(x.kind, 20) ?? 'other', custom: true, aliases: list(x.aliases, 10, (a) => text(a, 80) ?? '') }) }),
    logo: imageUrl(b.logo, 300_000) })
}
const PROFILE_KEYS = ['state', 'displayName', 'intro', 'description', 'cover', 'gallery', 'whatsapp', 'website', 'instagram', 'facebook', 'countryCode', 'country', 'region', 'city', 'lat', 'lng', 'placeId', 'slug', 'previousSlugs', 'languages', 'services', 'specialties', 'publishedAt'] as const
function profileIn(b: Record<string, unknown>) {
  noExtra(b, PROFILE_KEYS)
  if (!['draft', 'published', 'unpublished', 'closed'].includes(String(b.state))) throw bad('Invalid state')
  const num = (v: unknown, lo: number, hi: number) => { if (v === undefined) return undefined; if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw bad(); return v }
  const slug = text(b.slug, 80); if (slug && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw bad('Invalid slug')
  const strs = (v: unknown, n: number, m: number) => list(v, n, (x) => text(x, m) ?? (() => { throw bad() })())
  return clean({ state: b.state, displayName: text(b.displayName, 120), intro: text(b.intro, 300), description: text(b.description, 4000), cover: imageUrl(b.cover, 400_000), gallery: list(b.gallery, 6, (x) => imageUrl(x, 400_000) ?? (() => { throw bad() })()),
    whatsapp: text(b.whatsapp, 40), website: text(b.website, 200), instagram: text(b.instagram, 100), facebook: text(b.facebook, 100), countryCode: text(b.countryCode, 2), country: text(b.country, 64), region: text(b.region, 100), city: text(b.city, 100),
    lat: num(b.lat, -90, 90), lng: num(b.lng, -180, 180), placeId: text(b.placeId, 200), slug, previousSlugs: strs(b.previousSlugs, 20, 80), languages: strs(b.languages, 10, 10), services: strs(b.services, 50, 100), specialties: strs(b.specialties, 30, 100), publishedAt: text(b.publishedAt, 40) })
}
const validZone = (z: string) => { try { new Intl.DateTimeFormat('en', { timeZone: z }); return true } catch { return false } }

settingsRoutes.get('/clinic', async (c) => {
  const p = c.get('principal'), [r] = await c.get('db').rows('SELECT c.name, c.timezone, c.currency, s.settings, s.settings_version FROM clinic c LEFT JOIN clinic_settings s ON s.clinic_id = c.id WHERE c.id = $1', [p.clinicId])
  return c.json({ name: r.name, timezone: r.timezone, currency: r.currency, settings: r.settings ?? {}, version: r.settings_version ?? 0 })
})
settingsRoutes.put('/clinic', requires('settings.edit'), async (c) => {
  const p = c.get('principal'), b = await body(c); noExtra(b, ['expectedVersion', 'name', 'timezone', 'currency', 'settings'])
  if (!Number.isInteger(b.expectedVersion) || (b.expectedVersion as number) < 0) throw bad('expectedVersion must be an integer')
  const name = b.name === undefined ? undefined : text(b.name, 200), tz = text(b.timezone, 64), cur = text(b.currency, 3)
  if (b.name !== undefined && !name) throw bad('name is required'); if (tz && !validZone(tz)) throw bad('Unknown timezone'); if (cur && !/^[A-Z]{3}$/.test(cur)) throw bad('currency must be ISO 4217')
  if (!isRec(b.settings)) throw bad('settings is required'); const s = settingsIn(b.settings), now = toDb(c.get('now'))
  const v = await c.get('db').tx(async (db) => {
    await db.run('INSERT INTO clinic_settings (clinic_id, updated_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [p.clinicId, now])
    const [r] = await db.rows<{ settings_version: number }>('SELECT settings_version FROM clinic_settings WHERE clinic_id = $1 FOR UPDATE', [p.clinicId])
    if (r.settings_version !== b.expectedVersion) throw new ApiError(409, 'stale', 'The clinic settings changed; reload and try again')
    await db.run('UPDATE clinic_settings SET settings = $1::jsonb, settings_version = settings_version + 1, updated_at = $2 WHERE clinic_id = $3', [JSON.stringify(s), now, p.clinicId])
    await db.run('UPDATE clinic SET name = COALESCE($1, name), timezone = COALESCE($2, timezone), currency = COALESCE($3, currency) WHERE id = $4', [name ?? null, tz ?? null, cur ?? null, p.clinicId])
    return r.settings_version + 1
  })
  return c.json({ version: v })
})
// The public page content. Owner only (profile.*), with its own revision counter.
settingsRoutes.get('/clinic/profile', async (c) => {
  const [r] = await c.get('db').rows('SELECT profile, profile_version FROM clinic_settings WHERE clinic_id = $1', [c.get('principal').clinicId])
  return c.json({ profile: r?.profile && Object.keys(r.profile).length ? r.profile : null, version: r?.profile_version ?? 0 })
})
settingsRoutes.put('/clinic/profile', requires('profile.edit'), async (c) => {
  const p = c.get('principal'), b = await body(c); noExtra(b, ['expectedVersion', 'profile'])
  if (!Number.isInteger(b.expectedVersion) || (b.expectedVersion as number) < 0) throw bad('expectedVersion must be an integer')
  if (!isRec(b.profile)) throw bad('profile is required'); const pr = profileIn(b.profile), now = toDb(c.get('now'))
  const v = await c.get('db').tx(async (db) => {
    await db.run('INSERT INTO clinic_settings (clinic_id, updated_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [p.clinicId, now])
    const [r] = await db.rows<{ profile_version: number }>('SELECT profile_version FROM clinic_settings WHERE clinic_id = $1 FOR UPDATE', [p.clinicId])
    if (r.profile_version !== b.expectedVersion) throw new ApiError(409, 'stale', 'The profile changed; reload and try again')
    await db.run('UPDATE clinic_settings SET profile = $1::jsonb, profile_version = profile_version + 1, updated_at = $2 WHERE clinic_id = $3', [JSON.stringify(pr), now, p.clinicId])
    return r.profile_version + 1
  })
  return c.json({ version: v })
})

// ---- closures (holidays, temporary closures): read by date range ----
settingsRoutes.get('/clinic/closures', async (c) => {
  const q = c.req.query(), from = day(q.from), to = day(q.to)
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 730 || to < from) throw bad('from/to must be a range of at most 2 years')
  const rows = await c.get('db').rows('SELECT id, from_day::text AS "from", to_day::text AS "to", reason FROM clinic_closure WHERE clinic_id = $1 AND to_day >= $2::date AND from_day <= $3::date ORDER BY from_day, id LIMIT 200', [c.get('principal').clinicId, from, to])
  return c.json({ items: rows.map((r) => ({ id: r.id, from: r.from, to: r.to, reason: r.reason ?? undefined })) })
})
settingsRoutes.post('/clinic/closures', requires('settings.edit'), async (c) => {
  const b = await body(c), from = day(b.from), to = day(b.to ?? b.from), reason = text(b.reason, 200), id = newId(), p = c.get('principal')
  if (to < from || (Date.parse(to) - Date.parse(from)) / 864e5 > 366) throw bad('Invalid range')
  const [n] = await c.get('db').rows<{ n: string }>('SELECT count(*) n FROM clinic_closure WHERE clinic_id = $1', [p.clinicId]); if (Number(n.n) >= 500) throw new ApiError(409, 'limit', 'Too many closures; remove old ones')
  await c.get('db').run('INSERT INTO clinic_closure (id, clinic_id, from_day, to_day, reason) VALUES ($1,$2,$3::date,$4::date,$5)', [id, p.clinicId, from, to, reason ?? null])
  return c.json({ id }, 201)
})
settingsRoutes.delete('/clinic/closures/:id', requires('settings.edit'), async (c) => {
  const id = c.req.param('id'); if (!isUuid(id)) throw notFound()
  if ((await c.get('db').run('DELETE FROM clinic_closure WHERE id = $1 AND clinic_id = $2', [id, c.get('principal').clinicId])) !== 1) throw notFound(); return c.body(null, 204)
})

// ---- price list ----
const entry = (r: Record<string, unknown>) => ({ id: r.code, ...(r.name ? { name: r.name } : {}), price: Number(r.price) })
settingsRoutes.get('/catalog', async (c) => {
  const rows = await c.get('db').rows('SELECT code, name, price FROM catalog_entry WHERE clinic_id = $1 AND archived_at IS NULL ORDER BY code LIMIT 300', [c.get('principal').clinicId])
  return c.json({ items: rows.map(entry) })
})
settingsRoutes.put('/catalog/:code', requires('settings.edit'), async (c) => {
  const code = c.req.param('code'); if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(code)) throw bad('Invalid code')
  const b = await body(c); noExtra(b, ['name', 'price']); const name = text(b.name, 200), p = c.get('principal')
  const raw = typeof b.price === 'number' && Number.isFinite(b.price) ? String(b.price) : b.price; if (typeof raw !== 'string' || !/^\d{1,10}(\.\d{1,2})?$/.test(raw)) throw bad('Invalid price')
  const price = formatMoney(parseMoney(raw))
  await c.get('db').tx(async (db) => {
    const [n] = await db.rows<{ n: string }>('SELECT count(*) n FROM catalog_entry WHERE clinic_id = $1 AND archived_at IS NULL AND code <> $2', [p.clinicId, code]); if (Number(n.n) >= 299) throw new ApiError(409, 'limit', 'The price list is full')
    await db.run('INSERT INTO catalog_entry (clinic_id, code, name, price) VALUES ($1,$2,$3,$4) ON CONFLICT (clinic_id, code) DO UPDATE SET name = EXCLUDED.name, price = EXCLUDED.price, archived_at = NULL', [p.clinicId, code, name ?? null, price])
  })
  return c.body(null, 204)
})
settingsRoutes.delete('/catalog/:code', requires('settings.edit'), async (c) => {
  if ((await c.get('db').run('UPDATE catalog_entry SET archived_at = $1 WHERE clinic_id = $2 AND code = $3 AND archived_at IS NULL', [toDb(c.get('now')), c.get('principal').clinicId, c.req.param('code')])) !== 1) throw notFound(); return c.body(null, 204)
})
