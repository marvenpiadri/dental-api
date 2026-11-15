// Operator-only: create a clinic and its owner. Prints a temporary password once; the owner should change it after first login.
// Usage: node --env-file=.dev.vars tools/create-clinic.ts "<Clinic name>" <owner@email> "<Owner name>"
import { getDb } from '../src/db/client.ts'
import { createClinic } from '../src/admin/bootstrap.ts'

const [clinicName, ownerEmail, ownerName] = process.argv.slice(2)
const { TIDB_DATABASE_URL, PASSWORD_PEPPER } = process.env
if (!clinicName || !ownerEmail || !ownerName || !TIDB_DATABASE_URL || !PASSWORD_PEPPER) { console.error('usage: create-clinic.ts "<clinic>" <email> "<owner name>"  (needs TIDB_DATABASE_URL and PASSWORD_PEPPER)'); process.exit(1) }
const password = Array.from(crypto.getRandomValues(new Uint8Array(15)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('')
const r = await createClinic(getDb({ TIDB_DATABASE_URL }), PASSWORD_PEPPER, { clinicName, ownerEmail, ownerName, password })
console.log(`Clinic ${r.clinicId} created. Owner ${ownerEmail.toLowerCase()} temporary password: ${password}`)
