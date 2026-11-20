-- 0002 scheduling (PostgreSQL): patients, dentists, chairs, appointments. Double booking is impossible by EXCLUDE constraint, not by convention.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Gap-free per-clinic numbers (patient files, later invoices, credit notes, prescriptions). Incremented inside the issuing transaction.
CREATE TABLE doc_counter (
  clinic_id uuid NOT NULL REFERENCES clinic (id),
  kind      text NOT NULL,
  year      integer NOT NULL DEFAULT 0, -- 0 = not yearly
  last_seq  integer NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  PRIMARY KEY (clinic_id, kind, year)
);

CREATE TABLE patient (
  id                  uuid PRIMARY KEY,
  clinic_id           uuid NOT NULL REFERENCES clinic (id),
  number              text NOT NULL,                       -- 'P-0001', set once, never reused
  full_name           text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 200),
  search_name         text NOT NULL,                       -- lowercase, accent-free copy kept by the API (unaccent() is not immutable)
  phone               text CHECK (length(phone) <= 40),
  email               text CHECK (length(email) <= 254),
  birth_date          date,
  sex                 text CHECK (sex IN ('female','male')),
  country             text CHECK (length(country) <= 64),
  city                text CHECK (length(city) <= 100),
  address             text CHECK (length(address) <= 300),
  emergency_name      text CHECK (length(emergency_name) <= 200),
  emergency_phone     text CHECK (length(emergency_phone) <= 40),
  language            text CHECK (language IN ('en','fr')),
  referral            text CHECK (length(referral) <= 200),
  alert               text CHECK (length(alert) <= 500),
  notes               text CHECK (length(notes) <= 2000),
  whatsapp_consent    text CHECK (whatsapp_consent IN ('granted','declined')),
  whatsapp_consent_at timestamptz,
  created_at          timestamptz NOT NULL,
  archived_at         timestamptz,
  UNIQUE (clinic_id, id),
  UNIQUE (clinic_id, number)
);
CREATE INDEX ix_patient_order ON patient (clinic_id, search_name, id);
CREATE INDEX ix_patient_name_trgm ON patient USING gin (search_name gin_trgm_ops);
CREATE INDEX ix_patient_phone_trgm ON patient USING gin (phone gin_trgm_ops);

CREATE TABLE chair (
  id          uuid PRIMARY KEY,
  clinic_id   uuid NOT NULL REFERENCES clinic (id),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  color       text CHECK (color ~ '^#[0-9a-fA-F]{3,8}$'),
  archived_at timestamptz,
  UNIQUE (clinic_id, id)
);

CREATE TABLE dentist_profile (
  id           uuid PRIMARY KEY,
  clinic_id    uuid NOT NULL REFERENCES clinic (id),
  staff_id     uuid,
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  specialty    text CHECK (length(specialty) <= 100),
  color        text CHECK (color ~ '^#[0-9a-fA-F]{3,8}$'),
  phone        text CHECK (length(phone) <= 40),
  email        text CHECK (length(email) <= 254),
  registration text CHECK (length(registration) <= 64),
  hours        jsonb CHECK (jsonb_typeof(hours) = 'object'), -- own working times, e.g. {"open":"09:00","close":"17:00"}
  archived_at  timestamptz,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, staff_id) REFERENCES staff (clinic_id, id)
);

CREATE TABLE appointment (
  id         uuid PRIMARY KEY,
  clinic_id  uuid NOT NULL REFERENCES clinic (id),
  patient_id uuid NOT NULL,
  dentist_id uuid NOT NULL,
  chair_id   uuid NOT NULL,
  type       text NOT NULL DEFAULT 'consultation' CHECK (length(type) <= 32),
  status     text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','confirmed','arrived','in-progress','completed','cancelled','no-show')),
  start_at   timestamptz NOT NULL,
  end_at     timestamptz NOT NULL,
  reason     text CHECK (length(reason) <= 500),
  note       text CHECK (length(note) <= 2000),
  reminded_at timestamptz,
  version    integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  created_by uuid,
  updated_at timestamptz NOT NULL,
  UNIQUE (clinic_id, id),
  CHECK (end_at - start_at BETWEEN interval '15 minutes' AND interval '480 minutes'),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patient (clinic_id, id),
  FOREIGN KEY (clinic_id, dentist_id) REFERENCES dentist_profile (clinic_id, id),
  FOREIGN KEY (clinic_id, chair_id)   REFERENCES chair (clinic_id, id),
  FOREIGN KEY (clinic_id, created_by) REFERENCES staff (clinic_id, id),
  -- A dentist, a chair and a patient can each be in only one active appointment at any moment ([start, end) ranges: back-to-back is fine).
  EXCLUDE USING gist (dentist_id WITH =, tstzrange(start_at, end_at) WITH &&) WHERE (status IN ('scheduled','confirmed','arrived','in-progress','completed')),
  EXCLUDE USING gist (chair_id   WITH =, tstzrange(start_at, end_at) WITH &&) WHERE (status IN ('scheduled','confirmed','arrived','in-progress','completed')),
  EXCLUDE USING gist (patient_id WITH =, tstzrange(start_at, end_at) WITH &&) WHERE (status IN ('scheduled','confirmed','arrived','in-progress','completed'))
);
CREATE INDEX ix_appt_clinic_start ON appointment (clinic_id, start_at, id);
CREATE INDEX ix_appt_patient_start ON appointment (patient_id, start_at);

CREATE TABLE appointment_status_change (
  id             uuid PRIMARY KEY,
  clinic_id      uuid NOT NULL,
  appointment_id uuid NOT NULL,
  from_status    text,
  to_status      text NOT NULL,
  staff_id       uuid,
  reason         text CHECK (length(reason) <= 500),
  at             timestamptz NOT NULL,
  FOREIGN KEY (clinic_id, appointment_id) REFERENCES appointment (clinic_id, id),
  FOREIGN KEY (clinic_id, staff_id) REFERENCES staff (clinic_id, id)
);
CREATE INDEX ix_asc_appt ON appointment_status_change (appointment_id, at);
CREATE TRIGGER appointment_status_change_append_only BEFORE UPDATE OR DELETE ON appointment_status_change FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Every reschedule keeps the original booking.
CREATE TABLE appointment_schedule_change (
  id              uuid PRIMARY KEY,
  clinic_id       uuid NOT NULL,
  appointment_id  uuid NOT NULL,
  from_start      timestamptz NOT NULL, to_start timestamptz NOT NULL,
  from_dentist_id uuid NOT NULL, to_dentist_id uuid NOT NULL,
  from_chair_id   uuid NOT NULL, to_chair_id uuid NOT NULL,
  staff_id        uuid,
  at              timestamptz NOT NULL,
  FOREIGN KEY (clinic_id, appointment_id) REFERENCES appointment (clinic_id, id),
  FOREIGN KEY (clinic_id, staff_id) REFERENCES staff (clinic_id, id)
);
CREATE INDEX ix_asch_appt ON appointment_schedule_change (appointment_id, at);
CREATE TRIGGER appointment_schedule_change_append_only BEFORE UPDATE OR DELETE ON appointment_schedule_change FOR EACH ROW EXECUTE FUNCTION forbid_change();
