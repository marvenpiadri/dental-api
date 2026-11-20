// Operator-only: create a clinic and its owner. Usage: node --env-file=.dev.vars tools/create-clinic.ts "<Clinic>" <owner@email> "<Owner name>"
import { pgDb } from '../src/db/client.ts'
import { createClinic } from '../src/admin/bootstrap.ts'

const [clinicName, ownerEmail, ownerName] = process.argv.slice(2)
const { DATABASE_URL, PASSWORD_PEPPER } = process.env
if (!clinicName || !ownerEmail || !ownerName || !DATABASE_URL || !PASSWORD_PEPPER) { console.error('usage: create-clinic.ts "<clinic>" <email> "<owner name>"  (needs DATABASE_URL and PASSWORD_PEPPER)'); process.exit(1) }
const password = Array.from(crypto.getRandomValues(new Uint8Array(15)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('')
const db = pgDb(DATABASE_URL)
const r = await createClinic(db, PASSWORD_PEPPER, { clinicName, ownerEmail, ownerName, password })
await db.end()
console.log(`Clinic ${r.clinicId} created. Owner ${ownerEmail.toLowerCase()} temporary password: ${password}`)
