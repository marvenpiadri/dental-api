// Operator access: set a fresh random password for any staff account, so you can always get into a clinic without anyone's password ever being stored readable.
// Usage: node --env-file=.dev.vars tools/set-password.ts <email>      (prints the temporary password once, revokes the account's sessions)
import { getDb } from '../src/db/client.ts'
import { hashPassword } from '../src/auth/password.ts'

const email = process.argv[2]?.trim().toLowerCase()
if (!email) { console.error('usage: set-password.ts <email>'); process.exit(1) }
const { TIDB_DATABASE_URL, PASSWORD_PEPPER } = process.env
if (!TIDB_DATABASE_URL || !PASSWORD_PEPPER) { console.error('TIDB_DATABASE_URL and PASSWORD_PEPPER must be set'); process.exit(1) }
const db = getDb({ TIDB_DATABASE_URL })
const [u] = await db.rows<{ id: string }>('SELECT id FROM staff WHERE email_norm = ?', [email])
if (!u) { console.error('no such account'); process.exit(1) }
const temp = Array.from(crypto.getRandomValues(new Uint8Array(15)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('')
await db.run('UPDATE staff SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?', [await hashPassword(temp, PASSWORD_PEPPER), u.id])
await db.run('UPDATE auth_session SET revoked_at = ? WHERE staff_id = ? AND revoked_at IS NULL', [new Date().toISOString().replace('T', ' ').replace('Z', ''), u.id])
console.log(`Temporary password for ${email}: ${temp}`)
