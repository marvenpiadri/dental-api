import { DuplicateKeyError, type Db } from '../db/client.ts'
import { hashPassword } from '../auth/password.ts'
import { newId } from '../lib/ids.ts'
import { toDb } from '../lib/time.ts'

/** Operator-only (CLI): creates a clinic and its first owner in one transaction. There is deliberately no public sign-up endpoint. */
export async function createClinic(db: Db, pepper: string, a: { clinicName: string; ownerEmail: string; ownerName: string; password: string; timezone?: string }, now = Date.now()) {
  const email = a.ownerEmail.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) throw new Error('invalid email')
  if (!a.clinicName.trim() || a.clinicName.length > 200 || !a.ownerName.trim() || a.ownerName.length > 200) throw new Error('invalid name')
  const clinicId = newId(), staffId = newId(), t = toDb(now), hash = await hashPassword(a.password, pepper)
  try {
    await db.tx(async (q) => {
      await q.run('INSERT INTO clinic (id, name, timezone, created_at) VALUES ($1, $2, $3, $4)', [clinicId, a.clinicName.trim(), a.timezone ?? 'Africa/Casablanca', t])
      await q.run('INSERT INTO staff (id, clinic_id, email_norm, name, role, password_hash, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [staffId, clinicId, email, a.ownerName.trim(), 'owner', hash, t])
      await q.run('INSERT INTO audit_event (id, clinic_id, staff_id, action, created_at) VALUES ($1, $2, $3, $4, $5)', [newId(), clinicId, staffId, 'clinic.created', t])
    })
  } catch (e) { if (e instanceof DuplicateKeyError) throw new Error('email already in use'); throw e }
  return { clinicId, staffId }
}
