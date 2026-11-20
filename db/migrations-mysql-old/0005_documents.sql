-- 0005 documents (metadata only; the bytes live in a PRIVATE R2 bucket under the key stored here).
CREATE TABLE IF NOT EXISTS document (
  id VARCHAR(64) NOT NULL PRIMARY KEY, clinic_id VARCHAR(64) NOT NULL, patient_id VARCHAR(64) NOT NULL,
  name VARCHAR(200) NOT NULL, content_type VARCHAR(64) NOT NULL, size BIGINT NOT NULL, r2_key VARCHAR(200) NOT NULL,
  live TINYINT NOT NULL DEFAULT 0, uploaded_by VARCHAR(64) NULL, created_at DATETIME(3) NOT NULL,
  voided_at DATETIME(3) NULL, void_reason VARCHAR(500) NULL,
  KEY ix_doc_patient (clinic_id, patient_id, created_at, id)
);
