import type { Permission } from '../auth/permissions'

/**
 * The ONE place that says what may be uploaded for what. Every module's upload goes through the same service (routes.ts) and is described here:
 * types and size limits, who may upload / view / void, where the file attaches, and how it is retained.
 * `lossless` tells the browser not to re-encode (diagnostic images); the server cannot see that, it only enforces types and sizes.
 */
const MiB = 1024 * 1024
const IMG = ['image/jpeg', 'image/png', 'image/webp']
export type Purpose = {
  types: readonly string[]; max: number; lossless: boolean
  create: Permission; view: readonly Permission[]; void: Permission
  attach: 'patient' | 'lab' | 'owner'
  /** attach 'owner': the table whose row shows the picture (photo_file_id). Only one file at a time; a new one replaces the old. */
  owner?: { table: string; selfStaff?: boolean }
  /** Clinical record: can be voided, never deleted. Otherwise removing or replacing deletes the bytes. */
  retain: boolean
}
export const PURPOSES: Record<string, Purpose> = {
  patient_document: { types: [...IMG, 'application/pdf'], max: 25 * MiB, lossless: false, create: 'clinical.create', view: ['clinical.view'], void: 'clinical.void', attach: 'patient', retain: true },
  xray: { types: [...IMG, 'application/pdf', 'application/dicom'], max: 100 * MiB, lossless: true, create: 'clinical.create', view: ['clinical.view'], void: 'clinical.void', attach: 'patient', retain: true },
  clinical_image: { types: IMG, max: 25 * MiB, lossless: true, create: 'clinical.create', view: ['clinical.view'], void: 'clinical.void', attach: 'patient', retain: true },
  lab_attachment: { types: [...IMG, 'application/pdf'], max: 25 * MiB, lossless: false, create: 'practice.edit', view: ['practice.view', 'clinical.view'], void: 'practice.edit', attach: 'lab', retain: true },
  patient_photo: { types: IMG, max: 5 * MiB, lossless: false, create: 'patients.edit', view: ['patients.view'], void: 'patients.edit', attach: 'owner', owner: { table: 'patient' }, retain: false },
  staff_photo: { types: IMG, max: 5 * MiB, lossless: false, create: 'team.edit', view: ['appointments.view', 'team.view'], void: 'team.edit', attach: 'owner', owner: { table: 'staff', selfStaff: true }, retain: false },
  dentist_photo: { types: IMG, max: 5 * MiB, lossless: false, create: 'settings.edit', view: ['appointments.view'], void: 'settings.edit', attach: 'owner', owner: { table: 'dentist_profile' }, retain: false },
  product_image: { types: IMG, max: 5 * MiB, lossless: false, create: 'practice.edit', view: ['practice.view'], void: 'practice.edit', attach: 'owner', owner: { table: 'stock_item' }, retain: false },
}
export const OWNER_TABLES = new Set(Object.values(PURPOSES).flatMap((p) => (p.owner ? [p.owner.table] : [])))

const starts = (h: Uint8Array, at: number, sig: number[]) => h.length >= at + sig.length && sig.every((b, i) => h[at + i] === b)
/** The bytes decide the type; the client's Content-Type is only a claim. Needs the first 132 bytes. */
export const MAGIC_BYTES = 132
export const MAGIC: Record<string, (h: Uint8Array) => boolean> = {
  'application/pdf': (h) => starts(h, 0, [0x25, 0x50, 0x44, 0x46]),
  'image/jpeg': (h) => starts(h, 0, [0xff, 0xd8, 0xff]),
  'image/png': (h) => starts(h, 0, [0x89, 0x50, 0x4e, 0x47]),
  'image/webp': (h) => starts(h, 0, [0x52, 0x49, 0x46, 0x46]) && starts(h, 8, [0x57, 0x45, 0x42, 0x50]),
  'application/dicom': (h) => starts(h, 128, [0x44, 0x49, 0x43, 0x4d]),
}
