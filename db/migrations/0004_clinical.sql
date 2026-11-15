-- 0004 clinical. JSON columns hold chart payloads and the small medical-history lists only. Exams are append-only: a mistake is voided with a reason and re-entered.
CREATE TABLE IF NOT EXISTS patient_medical (
  patient_id VARCHAR(64) NOT NULL PRIMARY KEY, clinic_id VARCHAR(64) NOT NULL,
  conditions JSON NULL, allergies VARCHAR(2000) NULL, medications VARCHAR(2000) NULL, legacy_matched JSON NULL,
  version INT NOT NULL, updated_at DATETIME(3) NOT NULL, updated_by VARCHAR(64) NULL,
  KEY ix_medical_clinic (clinic_id, patient_id)
);
-- The patient's current working chart (the frontend's patient.odontogram), replaced with an optimistic version check.
CREATE TABLE IF NOT EXISTS patient_chart (
  patient_id VARCHAR(64) NOT NULL PRIMARY KEY, clinic_id VARCHAR(64) NOT NULL,
  chart JSON NOT NULL, payload_version VARCHAR(16) NOT NULL, version INT NOT NULL, updated_at DATETIME(3) NOT NULL, updated_by VARCHAR(64) NULL,
  KEY ix_pchart_clinic (clinic_id, patient_id)
);
CREATE TABLE IF NOT EXISTS exam (
  id VARCHAR(64) NOT NULL PRIMARY KEY, clinic_id VARCHAR(64) NOT NULL, patient_id VARCHAR(64) NOT NULL,
  at DATETIME(3) NOT NULL, dentist_id VARCHAR(64) NULL, note VARCHAR(4000) NULL,
  chart JSON NOT NULL, payload_version VARCHAR(16) NOT NULL, created_by VARCHAR(64) NULL, created_at DATETIME(3) NOT NULL,
  voided_at DATETIME(3) NULL, void_reason VARCHAR(500) NULL,
  KEY ix_exam_patient (clinic_id, patient_id, at, id)
);
CREATE TABLE IF NOT EXISTS treatment_item (
  id VARCHAR(64) NOT NULL PRIMARY KEY, clinic_id VARCHAR(64) NOT NULL, patient_id VARCHAR(64) NOT NULL,
  tooth VARCHAR(2) NULL, scope VARCHAR(10) NULL, quadrant INT NULL, procedure_id VARCHAR(64) NOT NULL, name VARCHAR(200) NULL,
  price DECIMAL(12,2) NOT NULL, currency CHAR(3) NOT NULL, status VARCHAR(8) NOT NULL, done_date DATE NULL, done_at DATETIME(3) NULL,
  appointment_id VARCHAR(64) NULL, created_at DATETIME(3) NOT NULL, created_by VARCHAR(64) NULL,
  KEY ix_titem_patient (clinic_id, patient_id, created_at, id)
);
