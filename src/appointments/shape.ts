/** The appointment columns the API reads and how they are sent; shared by the calendar list and a patient's visit list. */
export const appointmentCols = 'id, patient_id, dentist_id, chair_id, type, start_at, end_at, status, reason, note, reminded_at, version'
export const appointmentOut = (r: Record<string, unknown>) => ({ id: r.id, patientId: r.patient_id, dentistId: r.dentist_id, chairId: r.chair_id, type: r.type, startAt: r.start_at, endAt: r.end_at, status: r.status, reason: r.reason, note: r.note, remindedAt: r.reminded_at, version: r.version })
