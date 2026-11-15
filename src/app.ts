import { Hono } from 'hono'
import { authRoutes } from './auth/routes'
import { appointmentRoutes } from './appointments/routes'
import { getDb } from './db/client'
import { ApiError, fail } from './http/errors'
import { base, security } from './http/middleware'
import type { AppEnv, Deps } from './http/context'

export function createApp(deps: Deps = { db: (env) => getDb(env) }) {
  const app = new Hono<AppEnv>()
  app.use('*', base(deps), ...security)
  app.get('/health', (c) => c.json({ ok: true, service: 'dontalist-api' }))
  app.route('/v1/auth', authRoutes)
  app.route('/v1/appointments', appointmentRoutes)
  app.notFound((c) => fail(c, new ApiError(404, 'not_found', 'Not found')))
  app.onError((e, c) => {
    // Internal details stay in platform logs, never in the response.
    console.error('unhandled', c.get('requestId'), e instanceof Error ? e.message : e)
    return fail(c, new ApiError(503, 'unavailable', 'Service unavailable'))
  })
  return app
}
