-- 0006 prescriptions. Items live as JSON on the row so a draft edit is one atomic UPDATE and an issued row can never be half-changed.
-- status: draft | issued | voided | superseded. number/number_year/seq are NULL on drafts (UNIQUE allows many NULLs).
CREATE TABLE IF NOT EXISTS prescription (
  id VARCHAR(64) NOT NULL PRIMARY KEY, clinic_id VARCHAR(64) NOT NULL, patient_id VARCHAR(64) NOT NULL,
  dentist_id VARCHAR(64) NULL, appointment_id VARCHAR(64) NULL, template_id VARCHAR(64) NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'draft', number VARCHAR(24) NULL, number_year INT NULL, seq INT NULL,
  items JSON NOT NULL, notes VARCHAR(2000) NULL, acknowledged JSON NULL, snapshot JSON NULL,
  corrects_id VARCHAR(64) NULL, correction_reason VARCHAR(500) NULL, superseded_by_id VARCHAR(64) NULL,
  version INT NOT NULL DEFAULT 1, created_by VARCHAR(64) NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
  issued_at DATETIME(3) NULL, issued_by VARCHAR(64) NULL, voided_at DATETIME(3) NULL, void_reason VARCHAR(500) NULL,
  UNIQUE KEY ux_rx_number (clinic_id, number_year, seq),
  KEY ix_rx_patient (clinic_id, patient_id, created_at, id)
);
-- Append-only history: created, issued, voided, corrected (note = reason).
CREATE TABLE IF NOT EXISTS prescription_event (
  id VARCHAR(64) NOT NULL PRIMARY KEY, clinic_id VARCHAR(64) NOT NULL, prescription_id VARCHAR(64) NOT NULL,
  kind VARCHAR(16) NOT NULL, at DATETIME(3) NOT NULL, staff_id VARCHAR(64) NULL, note VARCHAR(500) NULL,
  KEY ix_rxe (clinic_id, prescription_id, at, id)
);
-- scope 'clinic' = shared by the clinic; 'dentist' = personal to owner_staff_id. Using a template copies its items; it is never referenced by issued rows' content.
CREATE TABLE IF NOT EXISTS rx_template (
  id VARCHAR(64) NOT NULL PRIMARY KEY, clinic_id VARCHAR(64) NOT NULL, scope VARCHAR(8) NOT NULL, owner_staff_id VARCHAR(64) NULL,
  name VARCHAR(120) NOT NULL, description VARCHAR(500) NULL, items JSON NOT NULL, version INT NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, archived_at DATETIME(3) NULL,
  KEY ix_rxt (clinic_id, name, id)
);
