-- 0010 central file storage. ONE table describes every uploaded file (X-rays, photos, documents, lab attachments, avatars, product images);
-- the bytes live in the PRIVATE R2 bucket under r2_key. Replaces the patient-only `document` table (its live rows are carried over).
CREATE TABLE file (
  id           uuid PRIMARY KEY,
  clinic_id    uuid NOT NULL REFERENCES clinic (id),
  purpose      text NOT NULL CHECK (purpose IN ('patient_document','xray','clinical_image','lab_attachment','patient_photo','staff_photo','dentist_photo','product_image')),
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  content_type text NOT NULL CHECK (content_type IN ('application/pdf','image/jpeg','image/png','image/webp','application/dicom')),
  size         bigint NOT NULL CHECK (size BETWEEN 1 AND 104857600),
  r2_key       text NOT NULL UNIQUE,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready')),  -- pending until the bytes are verified in the bucket
  patient_id   uuid,   -- clinical purposes: the patient the file belongs to
  lab_order_id uuid,   -- lab_attachment
  subject_id   uuid,   -- avatar / product purposes: the row that shows it (patient, staff, dentist_profile, stock_item); the owner row's photo_file_id points back here
  uploaded_by  uuid,
  created_at   timestamptz NOT NULL,
  ready_at     timestamptz,
  voided_at    timestamptz,
  void_reason  text CHECK (length(void_reason) <= 500),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patient (clinic_id, id),
  FOREIGN KEY (clinic_id, lab_order_id) REFERENCES lab_order (clinic_id, id),
  FOREIGN KEY (clinic_id, uploaded_by) REFERENCES staff (clinic_id, id),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  CHECK ((status = 'ready') = (ready_at IS NOT NULL)),
  -- every purpose has exactly the association it needs
  CHECK (CASE WHEN purpose IN ('patient_document','xray','clinical_image') THEN patient_id IS NOT NULL AND lab_order_id IS NULL AND subject_id IS NULL
              WHEN purpose = 'lab_attachment' THEN lab_order_id IS NOT NULL AND patient_id IS NOT NULL AND subject_id IS NULL
              ELSE subject_id IS NOT NULL AND patient_id IS NULL AND lab_order_id IS NULL END)
);
CREATE INDEX ix_file_patient ON file (clinic_id, patient_id, created_at DESC, id DESC) WHERE status = 'ready' AND voided_at IS NULL AND patient_id IS NOT NULL;
CREATE INDEX ix_file_lab ON file (clinic_id, lab_order_id, created_at DESC, id DESC) WHERE status = 'ready' AND voided_at IS NULL AND lab_order_id IS NOT NULL;
CREATE INDEX ix_file_pending ON file (created_at) WHERE status = 'pending';
CREATE INDEX ix_file_removed ON file (voided_at) WHERE voided_at IS NOT NULL;

-- Clinical files are records: a ready one can be voided, never edited or deleted. Avatars and product images are replaceable, so those rows can go
-- (after their bytes). Unfinished uploads may always be cleaned up.
CREATE FUNCTION guard_file() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE retained boolean := OLD.status = 'ready' AND OLD.purpose IN ('patient_document','xray','clinical_image','lab_attachment');
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF retained THEN RAISE EXCEPTION 'a stored clinical file cannot be deleted' USING ERRCODE = '55000'; END IF;
    RETURN OLD;
  END IF;
  IF retained AND (OLD.voided_at IS NOT NULL OR (to_jsonb(NEW) - 'voided_at' - 'void_reason') IS DISTINCT FROM (to_jsonb(OLD) - 'voided_at' - 'void_reason')) THEN
    RAISE EXCEPTION 'a stored clinical file can only be voided' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER file_guard BEFORE UPDATE OR DELETE ON file FOR EACH ROW EXECUTE FUNCTION guard_file();

INSERT INTO file (id, clinic_id, purpose, name, content_type, size, r2_key, status, patient_id, uploaded_by, created_at, ready_at, voided_at, void_reason)
  SELECT id, clinic_id, 'patient_document', name, content_type, size, r2_key, 'ready', patient_id, uploaded_by, created_at, created_at, voided_at, void_reason FROM document WHERE live;
DROP TABLE document;
DROP FUNCTION guard_document();

-- The owner row points at its current picture (replacing it voids the old file).
ALTER TABLE patient         ADD COLUMN photo_file_id uuid, ADD FOREIGN KEY (clinic_id, photo_file_id) REFERENCES file (clinic_id, id);
ALTER TABLE staff           ADD COLUMN photo_file_id uuid, ADD FOREIGN KEY (clinic_id, photo_file_id) REFERENCES file (clinic_id, id);
ALTER TABLE dentist_profile ADD COLUMN photo_file_id uuid, ADD FOREIGN KEY (clinic_id, photo_file_id) REFERENCES file (clinic_id, id);
ALTER TABLE stock_item      ADD COLUMN photo_file_id uuid, ADD FOREIGN KEY (clinic_id, photo_file_id) REFERENCES file (clinic_id, id);
