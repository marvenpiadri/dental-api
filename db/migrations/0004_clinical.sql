-- 0004 clinical (PostgreSQL). Charts are stored per tooth and per section, each with its own revision number, plus an append-only
-- revision log written in the same transaction. A client can change one tooth; it can never overwrite a whole chart.
CREATE TABLE patient_medical (
  patient_id     uuid PRIMARY KEY,
  clinic_id      uuid NOT NULL,
  conditions     jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(conditions) = 'array'),
  allergies      text CHECK (length(allergies) <= 2000),
  medications    text CHECK (length(medications) <= 2000),
  legacy_matched jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(legacy_matched) = 'array'),
  version        integer NOT NULL CHECK (version > 0),
  updated_at     timestamptz NOT NULL,
  updated_by     uuid,
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patient (clinic_id, id),
  FOREIGN KEY (clinic_id, updated_by) REFERENCES staff (clinic_id, id)
);
-- Every medical-history save keeps the previous content.
CREATE TABLE medical_revision (
  id         uuid PRIMARY KEY,
  clinic_id  uuid NOT NULL,
  patient_id uuid NOT NULL,
  version    integer NOT NULL,
  before     jsonb,
  after      jsonb NOT NULL,
  staff_id   uuid,
  at         timestamptz NOT NULL,
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patient (clinic_id, id)
);
CREATE INDEX ix_medrev_patient ON medical_revision (patient_id, at DESC);
CREATE TRIGGER medical_revision_append_only BEFORE UPDATE OR DELETE ON medical_revision FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE chart_head (
  patient_id      uuid PRIMARY KEY,
  clinic_id       uuid NOT NULL,
  payload_version text NOT NULL CHECK (payload_version ~ '^\d{1,3}\.\d{1,3}(\.\d{1,3})?$'),
  created_at      timestamptz NOT NULL,
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patient (clinic_id, id)
);
-- scope 'teeth' = the tooth as it is, 'plan' = the planned tooth. data holds the whole tooth record (odontogram AND periodontal fields).
CREATE TABLE chart_tooth (
  patient_id uuid NOT NULL REFERENCES chart_head (patient_id),
  scope      text NOT NULL CHECK (scope IN ('teeth','plan')),
  tooth      text NOT NULL CHECK (tooth ~ '^([1-4][1-8]|[5-8][1-5])$'),
  clinic_id  uuid NOT NULL,
  data       jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  rev        integer NOT NULL CHECK (rev > 0),
  updated_at timestamptz NOT NULL,
  updated_by uuid,
  PRIMARY KEY (patient_id, scope, tooth),
  FOREIGN KEY (clinic_id, updated_by) REFERENCES staff (clinic_id, id)
);
CREATE TABLE chart_section (
  patient_id uuid NOT NULL REFERENCES chart_head (patient_id),
  section    text NOT NULL CHECK (section IN ('globals','case')),
  clinic_id  uuid NOT NULL,
  data       jsonb NOT NULL,
  rev        integer NOT NULL CHECK (rev > 0),
  updated_at timestamptz NOT NULL,
  updated_by uuid,
  PRIMARY KEY (patient_id, section),
  FOREIGN KEY (clinic_id, updated_by) REFERENCES staff (clinic_id, id)
);
CREATE TABLE chart_revision (
  id         uuid PRIMARY KEY,
  clinic_id  uuid NOT NULL,
  patient_id uuid NOT NULL,
  group_id   uuid NOT NULL,                      -- one save / one restore
  scope      text NOT NULL CHECK (scope IN ('teeth','plan','globals','case')),
  tooth      text,                               -- null for globals/case
  rev        integer NOT NULL,
  op         text NOT NULL CHECK (op IN ('init','patch','replace','clear','restore')),
  before     jsonb,
  after      jsonb NOT NULL,
  reason     text CHECK (length(reason) <= 500),
  staff_id   uuid,
  at         timestamptz NOT NULL,
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patient (clinic_id, id),
  FOREIGN KEY (clinic_id, staff_id) REFERENCES staff (clinic_id, id)
);
CREATE INDEX ix_chartrev_patient ON chart_revision (patient_id, at DESC, id DESC);
CREATE INDEX ix_chartrev_tooth ON chart_revision (patient_id, scope, tooth, at DESC);
CREATE TRIGGER chart_revision_append_only BEFORE UPDATE OR DELETE ON chart_revision FOR EACH ROW EXECUTE FUNCTION forbid_change();
-- The head and its parts are never deleted (a restore writes new revisions instead).
CREATE TRIGGER chart_tooth_no_delete BEFORE DELETE ON chart_tooth FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER chart_section_no_delete BEFORE DELETE ON chart_section FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER chart_head_no_delete BEFORE DELETE ON chart_head FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Examinations: immutable full snapshots of the chart at a moment; only voiding (with a reason, once) is allowed.
CREATE TABLE exam (
  id              uuid PRIMARY KEY,
  clinic_id       uuid NOT NULL,
  patient_id      uuid NOT NULL,
  at              timestamptz NOT NULL,
  dentist_id      uuid,
  note            text CHECK (length(note) <= 4000),
  chart           jsonb NOT NULL CHECK (jsonb_typeof(chart) = 'object'),
  payload_version text NOT NULL,
  created_by      uuid,
  created_at      timestamptz NOT NULL,
  voided_at       timestamptz,
  void_reason     text CHECK (length(void_reason) <= 500),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patient (clinic_id, id),
  FOREIGN KEY (clinic_id, dentist_id) REFERENCES dentist_profile (clinic_id, id),
  FOREIGN KEY (clinic_id, created_by) REFERENCES staff (clinic_id, id)
);
CREATE INDEX ix_exam_patient ON exam (clinic_id, patient_id, at DESC, id DESC);
CREATE FUNCTION guard_exam() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'exam is append-only' USING ERRCODE = '55000'; END IF;
  IF OLD.voided_at IS NOT NULL OR (to_jsonb(NEW) - 'voided_at' - 'void_reason') <> (to_jsonb(OLD) - 'voided_at' - 'void_reason') THEN
    RAISE EXCEPTION 'an exam can only be voided, once' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER exam_guard BEFORE UPDATE OR DELETE ON exam FOR EACH ROW EXECUTE FUNCTION guard_exam();

CREATE TABLE treatment_item (
  id             uuid PRIMARY KEY,
  clinic_id      uuid NOT NULL,
  patient_id     uuid NOT NULL,
  tooth          text CHECK (tooth ~ '^([1-4][1-8]|[5-8][1-5])$'),
  scope          text CHECK (scope IN ('quadrant','upper','lower','mouth')),
  quadrant       integer CHECK (quadrant BETWEEN 1 AND 4),
  procedure_id   text NOT NULL CHECK (length(procedure_id) <= 64),
  name           text CHECK (length(name) <= 200),
  price          numeric(12,2) NOT NULL CHECK (price >= 0),
  currency       text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status         text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','done')),
  done_date      date,
  done_at        timestamptz,
  appointment_id uuid,
  created_at     timestamptz NOT NULL,
  created_by     uuid,
  UNIQUE (clinic_id, id),
  CHECK ((scope = 'quadrant') = (quadrant IS NOT NULL)),
  CHECK ((status = 'done') = (done_at IS NOT NULL)),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patient (clinic_id, id),
  FOREIGN KEY (clinic_id, appointment_id) REFERENCES appointment (clinic_id, id),
  FOREIGN KEY (clinic_id, created_by) REFERENCES staff (clinic_id, id)
);
CREATE INDEX ix_titem_patient ON treatment_item (clinic_id, patient_id, created_at, id);
-- Done = the clinical record: such an item can no longer change or be removed.
CREATE FUNCTION guard_treatment_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'done' THEN RAISE EXCEPTION 'a completed treatment cannot be changed or removed' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER treatment_item_guard BEFORE UPDATE OR DELETE ON treatment_item FOR EACH ROW EXECUTE FUNCTION guard_treatment_item();
