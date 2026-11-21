import { Hono } from 'hono'
import { authRoutes } from './auth/routes'
import { teamRoutes } from './team/routes'
import { resourceRoutes } from './team/resources'
import { patientRoutes } from './patients/routes'
import { appointmentRoutes } from './appointments/routes'
import { billingRoutes } from './billing/routes'
import { clinicalRoutes } from './clinical/routes'
import { documentRoutes } from './documents/routes'
import { prescriptionRoutes } from './prescriptions/routes'
import { settingsRoutes } from './settings/routes'
import { recordRoutes } from './records/routes'
import { pgDb } from './db/client'
import { r2Store } from './files/store'
import { ApiError, fail } from './http/errors'
import { base, security } from './http/middleware'
import type { AppEnv, Deps } from './http/context'

export function createApp(deps: Deps = { db: (env) => pgDb(env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL ?? ''), files: (env) => r2Store(env.FILES) }) {
  const app = new Hono<AppEnv>()
  app.use('*', base(deps), ...security)
  app.get('/health', (c) => c.json({ ok: true, service: 'dontalist-api' }))
  app.route('/v1/auth', authRoutes)
  app.route('/v1/staff', teamRoutes)
  app.route('/v1/patients', patientRoutes)
  app.route('/v1/appointments', appointmentRoutes)
  app.route('/v1', resourceRoutes)
  app.route('/v1', billingRoutes)
  app.route('/v1', clinicalRoutes)
  app.route('/v1', documentRoutes)
  app.route('/v1', prescriptionRoutes)
  app.route('/v1', settingsRoutes)
  app.route('/v1', recordRoutes)
  // PostgreSQL port in progress (roadmap P5-P6): documents, prescriptions are not mounted until ported and tested (legacy-tidb/).
  app.notFound((c) => fail(c, new ApiError(404, 'not_found', 'Not found')))
  app.onError((e, c) => {
    // Internal details stay in platform logs, never in the response.
    console.error('unhandled', c.get('requestId'), e instanceof Error ? e.message : e)
    return fail(c, new ApiError(503, 'unavailable', 'Service unavailable'))
  })
  return app
}
