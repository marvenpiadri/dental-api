// Operator access: set a fresh random password for any staff account. Usage: node --env-file=.dev.vars tools/set-password.ts <email>
import { pgDb } from '../src/db/client.ts'
import { httpPasswordService } from '../src/auth/password-service.ts'

const email = process.argv[2]?.trim().toLowerCase()
const { DATABASE_URL, PASSWORD_SERVICE_URL, PASSWORD_SERVICE_SECRET } = process.env
if (!email || !DATABASE_URL || !PASSWORD_SERVICE_URL || !PASSWORD_SERVICE_SECRET) { console.error('usage: set-password.ts <email>  (needs DATABASE_URL, PASSWORD_SERVICE_URL and PASSWORD_SERVICE_SECRET)'); process.exit(1) }
const db = pgDb(DATABASE_URL)
const [u] = await db.rows<{ id: string }>('SELECT id FROM staff WHERE email_norm = $1', [email])
if (!u) { console.error('no such account'); process.exit(1) }
const temp = Array.from(crypto.getRandomValues(new Uint8Array(15)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('')
await db.tx(async (q) => {
  await q.run('UPDATE staff SET password_hash = $1, failed_logins = 0, locked_until = NULL WHERE id = $2', [await httpPasswordService({ url: PASSWORD_SERVICE_URL, secret: PASSWORD_SERVICE_SECRET }).hash(temp), u.id])
  await q.run('UPDATE auth_session SET revoked_at = now() WHERE staff_id = $1 AND revoked_at IS NULL', [u.id])
})
await db.end()
console.log(`Temporary password for ${email}: ${temp}`)
