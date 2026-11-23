import { createApp } from './app'
import { pgDb } from './db/client'
import { purgeFiles } from './files/reap'
import { s3Store } from './files/store'
import type { Bindings } from './env'

export default {
  fetch: createApp().fetch,
  // Hourly (wrangler.jsonc triggers): delete abandoned uploads and replaced/removed pictures from the bucket.
  async scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    const db = pgDb(env.DATABASE_URL ?? '')
    ctx.waitUntil(purgeFiles(db, s3Store(env), Date.now()).finally(() => db.end()))
  },
}
