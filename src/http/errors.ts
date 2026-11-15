import type { Context } from 'hono'

export class ApiError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 503, public code: string, message?: string) { super(message ?? code) }
}
/** One envelope for every error. Messages here are written for clients; internals only ever go to logs. */
export const fail = (c: Context, e: ApiError) =>
  c.json({ error: { code: e.code, message: e.message }, requestId: c.get('requestId') }, e.status)
