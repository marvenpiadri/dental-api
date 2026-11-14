import { Hono } from 'hono'
import type { Bindings } from './env'

const app = new Hono<{ Bindings: Bindings }>()

app.get('/health', (c) => {
  return c.json({
    ok: true,
    service: 'dontalist-api',
  })
})

app.notFound((c) => c.json({ error: 'Not found' }, 404))

app.onError((error, c) => {
  // Keep internal error details in platform logs, never in the HTTP response.
  console.error('Unhandled API error', error)
  return c.json({ error: 'Internal server error' }, 500)
})

export default app
