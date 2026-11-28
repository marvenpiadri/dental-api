import { Hono } from 'hono'
import { ApiError, fail } from '../http/errors'
import type { AppEnv } from '../http/context'
import { parseLimit } from '../lib/pagination'

/** The public clinic directory: no sign-in, read-only, bounded. A clinic is listed only while a subscription period covers today AND its own profile is "published". Only public fields leave the database. */
export const publicRoutes = new Hono<AppEnv>()
publicRoutes.onError((e, c) => { if (e instanceof ApiError) return fail(c, e); throw e })

const slugify = (t: string) => t.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '')
const safeUrl = (u: unknown) => (typeof u === 'string' && /^https?:\/\/[^\s]+$/i.test(u) ? u : null)
const LISTED = `s.profile ->> 'state' = 'published' AND coalesce(s.profile ->> 'slug', '') <> '' AND coalesce(s.profile ->> 'city', '') <> ''
  AND EXISTS (SELECT 1 FROM clinic_subscription u WHERE u.clinic_id = c.id AND $1::date BETWEEN u.starts_on AND u.ends_on)`
const FROM = 'FROM clinic_settings s JOIN clinic c ON c.id = s.clinic_id'

publicRoutes.get('/clinics', async (c) => {
  const q = c.req.query(), limit = parseLimit(q.limit, 15, 50)
  const offset = q.offset === undefined ? 0 : /^\d{1,5}$/.test(q.offset) ? Number(q.offset) : -1
  if (limit === null || offset < 0 || (q.city ?? '').length > 100 || (q.q ?? '').length > 80) throw new ApiError(400, 'bad_request', 'Invalid request')
  const today = new Date(c.get('now')).toISOString().slice(0, 10), city = q.city?.trim() || null, term = q.q?.trim() || null, db = c.get('db')
  const filter = `${LISTED} AND ($2::text IS NULL OR lower(s.profile ->> 'city') = lower($2))
    AND ($3::text IS NULL OR strpos(lower(coalesce(s.profile ->> 'displayName', c.name) || ' ' || coalesce(s.settings ->> 'address', '') || ' ' || (s.profile ->> 'city')), lower($3)) > 0)`
  const [rows, [n], cities] = await Promise.all([
    db.rows<Record<string, string | null>>(`SELECT c.id, coalesce(s.profile ->> 'displayName', c.name) AS name, s.profile ->> 'intro' AS intro, s.profile ->> 'city' AS city, s.profile ->> 'region' AS region,
        s.profile ->> 'country' AS country, s.profile ->> 'countryCode' AS code, s.profile ->> 'slug' AS slug, s.settings ->> 'address' AS address, s.profile ->> 'whatsapp' AS whatsapp, s.profile ->> 'website' AS website
      ${FROM} WHERE ${filter} ORDER BY lower(coalesce(s.profile ->> 'displayName', c.name)), c.id LIMIT $4 OFFSET $5`, [today, city, term, limit, offset]),
    db.rows<{ n: string }>(`SELECT count(*) AS n ${FROM} WHERE ${filter}`, [today, city, term]),
    db.rows<{ city: string }>(`SELECT DISTINCT s.profile ->> 'city' AS city ${FROM} WHERE ${LISTED} ORDER BY 1 LIMIT 200`, [today]),
  ])
  c.header('Cache-Control', 'public, max-age=60')
  c.header('Access-Control-Allow-Origin', '*') // a read-only public list, no cookies: the marketing site may read it
  c.header('Cross-Origin-Resource-Policy', 'cross-origin')
  return c.json({
    total: Number(n.n), offset, limit, cities: cities.map((r) => r.city),
    items: rows.map((r) => ({ id: r.id, name: r.name, intro: r.intro, city: r.city, region: r.region, address: r.address, whatsapp: r.whatsapp, website: safeUrl(r.website), path: `/clinics/${slugify(r.country || r.code || '')}/${slugify(r.city ?? '')}/${r.slug}` })),
  })
})
