-- 0008 visit notes, quotes, and the clinic's medication / allergy lists with each patient's records.
CREATE TABLE visit_note (
  id             uuid PRIMARY KEY,
  clinic_id      uuid NOT NULL,
  patient_id     uuid NOT NULL,
  appointment_id uuid,
  dentist_id     uuid,
  complaint      text CHECK (length(complaint) <= 4000),
  findings       text CHECK (length(findings) <= 4000),
  care           text CHECK (length(care) <= 4000),
  prescription   jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(prescription) = 'array' AND jsonb_array_length(prescription) <= 30),
  version        integer NOT NULL DEFAULT 1,
  at             timestamptz NOT NULL,
  created_by     uuid,
  voided_at      timestamptz,
  void_reason    text CHECK (length(void_reason) <= 500),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, patient_id)     REFERENCES patient (clinic_id, id),
  FOREIGN KEY (clinic_id, appointment_id) REFERENCES appointment (clinic_id, id),
  FOREIGN KEY (clinic_id, dentist_id)     REFERENCES dentist_profile (clinic_id, id),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX ix_visit_patient ON visit_note (clinic_id, patient_id, at DESC, id DESC);
CREATE TRIGGER visit_note_no_delete BEFORE DELETE ON visit_note FOR EACH ROW EXECUTE FUNCTION forbid_change();
-- A correction keeps what was there before.
CREATE TABLE visit_note_revision (
  id           uuid PRIMARY KEY,
  clinic_id    uuid NOT NULL,
  note_id      uuid NOT NULL,
  version      integer NOT NULL,
  complaint    text, findings text, care text,
  prescription jsonb NOT NULL,
  at           timestamptz NOT NULL,
  staff_id     uuid,
  FOREIGN KEY (clinic_id, note_id) REFERENCES visit_note (clinic_id, id)
);
CREATE INDEX ix_visit_rev ON visit_note_revision (note_id, version);
CREATE TRIGGER visit_note_revision_append_only BEFORE UPDATE OR DELETE ON visit_note_revision FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Quotes: a newer quote supersedes an unanswered older one; nothing is deleted or edited.
CREATE TABLE plan_proposal (
  id         uuid PRIMARY KEY,
  clinic_id  uuid NOT NULL,
  patient_id uuid NOT NULL,
  version    integer NOT NULL CHECK (version >= 1),
  lines      jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) BETWEEN 1 AND 60),
  total      numeric(12,2) NOT NULL CHECK (total >= 0),
  status     text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','declined','superseded')),
  at         timestamptz NOT NULL,
  decided_at timestamptz,
  created_by uuid,
  UNIQUE (clinic_id, patient_id, version),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patient (clinic_id, id),
  CHECK ((status IN ('accepted','declined')) = (decided_at IS NOT NULL))
);
CREATE INDEX ix_proposal ON plan_proposal (clinic_id, patient_id, version DESC);
CREATE FUNCTION guard_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'a quote cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF NEW.lines <> OLD.lines OR NEW.total <> OLD.total OR NEW.version <> OLD.version OR NEW.at <> OLD.at OR NEW.patient_id <> OLD.patient_id THEN RAISE EXCEPTION 'a quote cannot be edited' USING ERRCODE = '55000'; END IF;
  IF NEW.status <> OLD.status AND OLD.status <> 'proposed' THEN RAISE EXCEPTION 'a quote that was answered or replaced cannot change' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER proposal_guard BEFORE UPDATE OR DELETE ON plan_proposal FOR EACH ROW EXECUTE FUNCTION guard_proposal();

-- The clinic's medication master list. A generic stands alone; a brand points at a generic. Nothing is built in.
CREATE TABLE lib_medication (
  id                uuid PRIMARY KEY,
  clinic_id         uuid NOT NULL REFERENCES clinic (id),
  kind              text NOT NULL CHECK (kind IN ('generic','brand')),
  name              text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  generic_id        uuid,
  notes             text CHECK (length(notes) <= 2000),
  review_conditions jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(review_conditions) = 'array' AND jsonb_array_length(review_conditions) <= 30),
  hidden            boolean NOT NULL DEFAULT false,
  external_id       text CHECK (length(external_id) <= 100),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, generic_id) REFERENCES lib_medication (clinic_id, id),
  CHECK ((kind = 'brand') = (generic_id IS NOT NULL))
);
CREATE INDEX ix_libmed ON lib_medication (clinic_id, name, id);
CREATE TABLE allergy_def (
  id            uuid PRIMARY KEY,
  clinic_id     uuid NOT NULL REFERENCES clinic (id),
  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  medication_id uuid,
  external_id   text CHECK (length(external_id) <= 100),
  hidden        boolean NOT NULL DEFAULT false,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, medication_id) REFERENCES lib_medication (clinic_id, id)
);
CREATE INDEX ix_allergydef ON allergy_def (clinic_id, name, id);

CREATE TABLE patient_allergy (
  id            uuid PRIMARY KEY,
  clinic_id     uuid NOT NULL,
  patient_id    uuid NOT NULL,
  allergy_id    uuid NOT NULL,
  label         text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 200),
  reaction      text CHECK (length(reaction) <= 500),
  reaction_date date,
  active        boolean NOT NULL DEFAULT true,
  legacy_text   text CHECK (length(legacy_text) <= 500),
  created_at    timestamptz NOT NULL,
  removed_at    timestamptz,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patient (clinic_id, id),
  FOREIGN KEY (clinic_id, allergy_id) REFERENCES allergy_def (clinic_id, id)
);
CREATE INDEX ix_pallergy ON patient_allergy (clinic_id, patient_id, created_at, id) WHERE removed_at IS NULL;
CREATE TABLE patient_medication (
  id              uuid PRIMARY KEY,
  clinic_id       uuid NOT NULL,
  patient_id      uuid NOT NULL,
  medication_id   uuid NOT NULL,
  label           text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 200),
  notes           text CHECK (length(notes) <= 500),
  start_day       date,
  stop_day        date,
  active          boolean NOT NULL DEFAULT true,
  source          text CHECK (source IN ('manual','prescribed','reported')),
  prescription_id uuid,
  legacy_text     text CHECK (length(legacy_text) <= 500),
  created_at      timestamptz NOT NULL,
  removed_at      timestamptz,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, patient_id)      REFERENCES patient (clinic_id, id),
  FOREIGN KEY (clinic_id, medication_id)   REFERENCES lib_medication (clinic_id, id),
  FOREIGN KEY (clinic_id, prescription_id) REFERENCES prescription (clinic_id, id),
  CHECK (stop_day IS NULL OR start_day IS NULL OR stop_day >= start_day)
);
CREATE INDEX ix_pmed ON patient_medication (clinic_id, patient_id, created_at, id) WHERE removed_at IS NULL;
-- What happened to a patient's allergy or medication record (the frontend's `history`).
CREATE TABLE patient_record_event (
  id         uuid PRIMARY KEY,
  clinic_id  uuid NOT NULL,
  patient_id uuid NOT NULL,
  record_id  uuid NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('allergy','medication')),
  what       text NOT NULL CHECK (length(what) <= 60),
  note       text CHECK (length(note) <= 500),
  at         timestamptz NOT NULL,
  staff_id   uuid
);
CREATE INDEX ix_precord_event ON patient_record_event (record_id, at, id);
CREATE TRIGGER precord_event_append_only BEFORE UPDATE OR DELETE ON patient_record_event FOR EACH ROW EXECUTE FUNCTION forbid_change();
