-- 0006 clinic settings and public profile, closures, price list, letters, patient insurance, waiting list, messages.
-- Settings and the public profile are document-like (the frontend edits them as one form), so they are validated JSONB with their own revision counters.
CREATE TABLE clinic_settings (
  clinic_id        uuid PRIMARY KEY REFERENCES clinic (id),
  settings         jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(settings) = 'object' AND pg_column_size(settings) < 200000),
  settings_version integer NOT NULL DEFAULT 0,
  profile          jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(profile) = 'object' AND pg_column_size(profile) < 1500000),
  profile_version  integer NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL
);
CREATE TABLE clinic_closure (
  id        uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES clinic (id),
  from_day  date NOT NULL,
  to_day    date NOT NULL,
  reason    text CHECK (length(reason) <= 200),
  CHECK (to_day >= from_day AND to_day - from_day <= 366)
);
CREATE INDEX ix_closure ON clinic_closure (clinic_id, from_day, id);

-- The clinic's price list. code = a built-in procedure id (filling, cleaning ...) or a custom one.
CREATE TABLE catalog_entry (
  clinic_id   uuid NOT NULL REFERENCES clinic (id),
  code        text NOT NULL CHECK (code ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  name        text CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  price       numeric(12,2) NOT NULL CHECK (price >= 0),
  archived_at timestamptz,
  PRIMARY KEY (clinic_id, code)
);

-- Certificates and referral letters are never edited: a mistake is corrected by writing a new one.
CREATE TABLE letter (
  id         uuid PRIMARY KEY,
  clinic_id  uuid NOT NULL,
  patient_id uuid NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('certificate','referral')),
  dentist_id uuid,
  to_whom    text CHECK (length(to_whom) <= 200),
  rest_days  integer CHECK (rest_days BETWEEN 0 AND 365),
  text       text NOT NULL CHECK (length(btrim(text)) BETWEEN 1 AND 6000),
  at         timestamptz NOT NULL,
  created_by uuid,
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patient (clinic_id, id),
  FOREIGN KEY (clinic_id, dentist_id) REFERENCES dentist_profile (clinic_id, id),
  FOREIGN KEY (clinic_id, created_by) REFERENCES staff (clinic_id, id)
);
CREATE INDEX ix_letter_patient ON letter (clinic_id, patient_id, at DESC, id DESC);
CREATE TRIGGER letter_append_only BEFORE UPDATE OR DELETE ON letter FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Who covers the patient (not claims, not payments).
CREATE TABLE patient_insurance (
  id            uuid PRIMARY KEY,
  clinic_id     uuid NOT NULL,
  patient_id    uuid NOT NULL,
  provider_id   text NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 60),
  provider_name text NOT NULL CHECK (length(btrim(provider_name)) BETWEEN 1 AND 120),
  number        text NOT NULL CHECK (length(btrim(number)) BETWEEN 1 AND 40),
  policy        text CHECK (length(policy) <= 60),
  notes         text CHECK (length(notes) <= 500),
  added_at      timestamptz NOT NULL,
  removed_at    timestamptz,
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patient (clinic_id, id)
);
CREATE INDEX ix_pins ON patient_insurance (clinic_id, patient_id, added_at, id) WHERE removed_at IS NULL;

ALTER TABLE patient ADD COLUMN waiting_since timestamptz;
CREATE INDEX ix_patient_waiting ON patient (clinic_id, waiting_since, id) WHERE waiting_since IS NOT NULL AND archived_at IS NULL;

-- WhatsApp messages the front desk prepared (the clinic presses send in WhatsApp itself).
CREATE TABLE message (
  id             uuid PRIMARY KEY,
  clinic_id      uuid NOT NULL,
  patient_id     uuid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('appointment','balance','recall')),
  text           text NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  status         text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','sent','delivered','read','failed')),
  appointment_id uuid,
  external_id    text CHECK (length(external_id) <= 200),
  at             timestamptz NOT NULL,
  created_by     uuid,
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patient (clinic_id, id),
  FOREIGN KEY (clinic_id, appointment_id) REFERENCES appointment (clinic_id, id)
);
CREATE INDEX ix_message_patient ON message (clinic_id, patient_id, at DESC, id DESC);
