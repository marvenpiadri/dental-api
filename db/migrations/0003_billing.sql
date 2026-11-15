-- 0003 billing. Money is DECIMAL(12,2); the API computes in BigInt minor units. Invoices are never edited or deleted: cancel = credit note.
-- Numbers: unique per clinic + kind + year. Gap-FREE is not claimed: a crash between header and lines can leave a non-live row that keeps its number (a recorded gap).
CREATE TABLE IF NOT EXISTS invoice (
  id VARCHAR(64) NOT NULL PRIMARY KEY, clinic_id VARCHAR(64) NOT NULL, patient_id VARCHAR(64) NOT NULL,
  kind VARCHAR(12) NOT NULL,            -- 'invoice' | 'credit-note'
  number_year INT NOT NULL, seq INT NOT NULL, number VARCHAR(20) NOT NULL,
  issued_at DATETIME(3) NOT NULL, total DECIMAL(12,2) NOT NULL, currency CHAR(3) NOT NULL,
  cancels_id VARCHAR(64) NULL, cancelled_at DATETIME(3) NULL, cancel_reason VARCHAR(500) NULL,
  live TINYINT NOT NULL DEFAULT 0, created_by VARCHAR(64) NULL,
  UNIQUE KEY uq_invoice_number (clinic_id, kind, number_year, seq),
  KEY ix_invoice_patient (clinic_id, patient_id, issued_at, id)
);
CREATE TABLE IF NOT EXISTS invoice_line (
  invoice_id VARCHAR(64) NOT NULL, position INT NOT NULL, clinic_id VARCHAR(64) NOT NULL,
  item_id VARCHAR(64) NULL, label VARCHAR(300) NOT NULL, where_text VARCHAR(100) NULL, price DECIMAL(12,2) NOT NULL,
  PRIMARY KEY (invoice_id, position)
);
CREATE TABLE IF NOT EXISTS payment (
  id VARCHAR(64) NOT NULL PRIMARY KEY, clinic_id VARCHAR(64) NOT NULL, patient_id VARCHAR(64) NOT NULL, invoice_id VARCHAR(64) NULL,
  amount DECIMAL(12,2) NOT NULL, method VARCHAR(12) NOT NULL, at DATETIME(3) NOT NULL, reference VARCHAR(100) NULL, note VARCHAR(500) NULL,
  payer_type VARCHAR(32) NULL, payer_id VARCHAR(64) NULL, currency CHAR(3) NOT NULL,
  voided_at DATETIME(3) NULL, void_reason VARCHAR(500) NULL, created_by VARCHAR(64) NULL,
  KEY ix_payment_patient (clinic_id, patient_id, at, id),
  KEY ix_payment_invoice (clinic_id, invoice_id)
);
