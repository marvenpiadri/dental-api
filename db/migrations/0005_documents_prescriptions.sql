-- 0005 documents (metadata; the bytes live in a PRIVATE R2 bucket under r2_key) and prescriptions (templates, drafts, issued records).
CREATE TABLE document (
  id           uuid PRIMARY KEY,
  clinic_id    uuid NOT NULL,
  patient_id   uuid NOT NULL,
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  content_type text NOT NULL CHECK (content_type IN ('application/pdf','image/jpeg','image/png','image/webp')),
  size         bigint NOT NULL CHECK (size BETWEEN 1 AND 26214400),
  r2_key       text NOT NULL,
  live         boolean NOT NULL DEFAULT false,  -- false while the upload is in flight; only live rows are ever shown
  uploaded_by  uuid,
  created_at   timestamptz NOT NULL,
  voided_at    timestamptz,
  void_reason  text CHECK (length(void_reason) <= 500),
  UNIQUE (r2_key),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patient (clinic_id, id),
  FOREIGN KEY (clinic_id, uploaded_by) REFERENCES staff (clinic_id, id),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX ix_document_patient ON document (clinic_id, patient_id, created_at DESC, id DESC) WHERE live AND voided_at IS NULL;
-- A live document is a clinical record: it can be voided, never edited or deleted. Unfinished uploads (live = false) may be cleaned up.
CREATE FUNCTION guard_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.live THEN RAISE EXCEPTION 'a stored document cannot be deleted' USING ERRCODE = '55000'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.live AND (NEW.live IS DISTINCT FROM OLD.live OR NEW.name <> OLD.name OR NEW.content_type <> OLD.content_type OR NEW.size <> OLD.size OR NEW.r2_key <> OLD.r2_key
     OR NEW.patient_id <> OLD.patient_id OR NEW.clinic_id <> OLD.clinic_id OR NEW.created_at <> OLD.created_at OR (OLD.voided_at IS NOT NULL AND NEW.voided_at IS DISTINCT FROM OLD.voided_at)) THEN
    RAISE EXCEPTION 'a stored document can only be voided' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_guard BEFORE UPDATE OR DELETE ON document FOR EACH ROW EXECUTE FUNCTION guard_document();

-- Prescription templates: 'clinic' = shared; 'dentist' = personal to owner_staff_id. Using one copies its items.
CREATE TABLE rx_template (
  id             uuid PRIMARY KEY,
  clinic_id      uuid NOT NULL REFERENCES clinic (id),
  scope          text NOT NULL CHECK (scope IN ('clinic','dentist')),
  owner_staff_id uuid,
  name           text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description    text CHECK (length(description) <= 500),
  items          jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) <= 30),
  version        integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL,
  archived_at    timestamptz,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, owner_staff_id) REFERENCES staff (clinic_id, id),
  CHECK ((scope = 'dentist') = (owner_staff_id IS NOT NULL))
);
CREATE INDEX ix_rx_template ON rx_template (clinic_id, name, id) WHERE archived_at IS NULL;

-- status: draft | issued | voided | superseded. Number columns are NULL on drafts; (clinic, year, seq) is unique once issued.
CREATE TABLE prescription (
  id                uuid PRIMARY KEY,
  clinic_id         uuid NOT NULL,
  patient_id        uuid NOT NULL,
  dentist_id        uuid,
  appointment_id    uuid,
  template_id       uuid,
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','voided','superseded')),
  number            text,
  number_year       integer,
  seq               integer,
  items             jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) <= 30),
  notes             text CHECK (length(notes) <= 2000),
  acknowledged      jsonb CHECK (jsonb_typeof(acknowledged) = 'array'),
  snapshot          jsonb,                -- clinic, dentist and patient details frozen at issue
  corrects_id       uuid,
  correction_reason text CHECK (length(correction_reason) <= 500),
  superseded_by_id  uuid,
  version           integer NOT NULL DEFAULT 1,
  created_by        uuid,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  issued_at         timestamptz,
  issued_by         uuid,
  voided_at         timestamptz,
  void_reason       text CHECK (length(void_reason) <= 500),
  UNIQUE (clinic_id, id),
  UNIQUE (clinic_id, number_year, seq),
  FOREIGN KEY (clinic_id, patient_id)     REFERENCES patient (clinic_id, id),
  FOREIGN KEY (clinic_id, dentist_id)     REFERENCES dentist_profile (clinic_id, id),
  FOREIGN KEY (clinic_id, appointment_id) REFERENCES appointment (clinic_id, id),
  FOREIGN KEY (clinic_id, template_id)    REFERENCES rx_template (clinic_id, id),
  FOREIGN KEY (clinic_id, corrects_id)    REFERENCES prescription (clinic_id, id),
  FOREIGN KEY (clinic_id, created_by)     REFERENCES staff (clinic_id, id),
  FOREIGN KEY (clinic_id, issued_by)      REFERENCES staff (clinic_id, id),
  CHECK ((status = 'draft') = (number IS NULL)),
  CHECK ((status = 'draft') = (issued_at IS NULL)),
  CHECK ((status = 'voided') = (voided_at IS NOT NULL)),
  CHECK (status = 'draft' OR snapshot IS NOT NULL)
);
CREATE INDEX ix_rx_patient ON prescription (clinic_id, patient_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX ux_rx_one_open_correction ON prescription (clinic_id, corrects_id) WHERE status = 'draft' AND corrects_id IS NOT NULL;
-- Once issued, the content never changes: only the status can move issued -> voided / superseded. Issued prescriptions are never deleted.
CREATE FUNCTION guard_prescription() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'an issued prescription cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF NEW.clinic_id <> OLD.clinic_id OR NEW.patient_id <> OLD.patient_id OR NEW.dentist_id IS DISTINCT FROM OLD.dentist_id OR NEW.items <> OLD.items OR NEW.notes IS DISTINCT FROM OLD.notes
     OR NEW.number IS DISTINCT FROM OLD.number OR NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW.acknowledged IS DISTINCT FROM OLD.acknowledged OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.corrects_id IS DISTINCT FROM OLD.corrects_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an issued prescription cannot be changed' USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'issued' AND NEW.status IN ('voided','superseded')) THEN RAISE EXCEPTION 'invalid prescription status change' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER prescription_guard BEFORE UPDATE OR DELETE ON prescription FOR EACH ROW EXECUTE FUNCTION guard_prescription();

-- Append-only history: created, issued, superseded, voided (note = reason).
CREATE TABLE prescription_event (
  id              uuid PRIMARY KEY,
  clinic_id       uuid NOT NULL,
  prescription_id uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('created','issued','superseded','voided')),
  at              timestamptz NOT NULL,
  staff_id        uuid,
  note            text CHECK (length(note) <= 500),
  FOREIGN KEY (clinic_id, prescription_id) REFERENCES prescription (clinic_id, id)
);
CREATE INDEX ix_rxe ON prescription_event (prescription_id, at, id);
CREATE TRIGGER prescription_event_append_only BEFORE UPDATE OR DELETE ON prescription_event FOR EACH ROW EXECUTE FUNCTION forbid_change();
