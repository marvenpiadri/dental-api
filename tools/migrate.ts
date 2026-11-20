// Usage: node --env-file=.dev.vars tools/migrate.ts   (DATABASE_URL_MIGRATE = owner role, direct Neon string). Never run against production without approval.
import { migrate } from './migrate-lib.ts'
const url = process.env.DATABASE_URL_MIGRATE
if (!url) { console.error('DATABASE_URL_MIGRATE must be set'); process.exit(1) }
const done = await migrate(url, 'db/migrations', console.log)
console.log(done.length ? `${done.length} applied` : 'up to date')
