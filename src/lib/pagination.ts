export const DEFAULT_PAGE_SIZE = 25
export const MAX_PAGE_SIZE = 100

/** Parses ?limit; invalid or out-of-range values are rejected (400), never silently widened. */
export function parseLimit(v: string | undefined, dflt = DEFAULT_PAGE_SIZE, max = MAX_PAGE_SIZE): number | null {
  if (v === undefined || v === '') return dflt
  if (!/^\d{1,4}$/.test(v)) return null
  const n = Number(v)
  return n >= 1 && n <= max ? n : null
}

/** Opaque keyset cursor: the last row's sort value + unique id. Validated on decode (it comes from the client). */
export function encodeCursor(sort: string, id: string): string {
  return btoa(JSON.stringify([sort, id])).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function decodeCursor(c: string | undefined): [string, string] | null | undefined {
  if (c === undefined || c === '') return undefined
  try {
    const v = JSON.parse(atob(c.replace(/-/g, '+').replace(/_/g, '/')))
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' && v[0].length <= 64 && v[1].length <= 64) return [v[0], v[1]]
  } catch { /* fall through */ }
  return null
}

/** Fetch limit+1 rows to know whether another page exists without a COUNT(*). */
export function page<T>(rows: T[], limit: number, cursorOf: (r: T) => string): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit)
  return { items, nextCursor: rows.length > limit ? cursorOf(items[items.length - 1]) : null }
}
