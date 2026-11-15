import type { Db } from '../db/client'
import { hashPassword } from '../auth/password'
import { newId } from '../lib/ids'
import { toDb } from '../lib/time'

/** Operator-only (CLI): creates a clinic and its first owner. There is deliberately no public sign-up endpoint. */
export async function createClinic(db: Db, pepper: string, a: { clinicName: string; ownerEmail: string; ownerName: string; password: string; timezone?: string }, now = Date.now()) {
  const email = a.ownerEmail.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) throw new Error('invalid email')
  if (!a.clinicName.trim() || a.clinicName.length > 200 || !a.ownerName.trim() || a.ownerName.length > 200) throw new Error('invalid name')
  if ((await db.rows('SELECT id FROM staff WHERE email_norm = ?', [email])).length) throw new Error('email already in use')
  const clinicId = newId(), staffId = newId(), t = toDb(now)
  await db.run('INSERT INTO clinic (id, name, timezone, created_at) VALUES (?, ?, ?, ?)', [clinicId, a.clinicName.trim(), a.timezone ?? 'Africa/Casablanca', t])
  await db.run('INSERT INTO staff (id, clinic_id, email_norm, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [staffId, clinicId, email, a.ownerName.trim(), 'owner', await hashPassword(a.password, pepper), t])
  await db.run('INSERT INTO audit_event (id, clinic_id, staff_id, action, created_at) VALUES (?, ?, ?, ?, ?)', [newId(), clinicId, staffId, 'clinic.created', t])
  return { clinicId, staffId }
}
