-- 0016 subscriptions and the public clinic listing. A clinic appears on the public directory only while a subscription period covers today (and its own profile says "published").
-- Periods never overlap for one clinic (EXCLUDE), so "active today" is unambiguous. Only the operator console writes this table; clinics cannot.
CREATE TABLE clinic_subscription (
  id         uuid PRIMARY KEY,
  clinic_id  uuid NOT NULL REFERENCES clinic (id),
  starts_on  date NOT NULL,
  ends_on    date NOT NULL,
  note       text CHECK (length(note) <= 500),
  created_at timestamptz NOT NULL,
  CHECK (ends_on >= starts_on),
  EXCLUDE USING gist (clinic_id WITH =, daterange(starts_on, ends_on, '[]') WITH &&)
);
CREATE INDEX ix_subscription_active ON clinic_subscription (clinic_id, ends_on DESC);
-- One public address per clinic: country code + city + slug, as the app builds /clinics/{country}/{city}/{slug}.
CREATE UNIQUE INDEX ux_clinic_public_path ON clinic_settings ((lower(profile ->> 'countryCode')), (lower(profile ->> 'city')), (profile ->> 'slug')) WHERE profile ? 'slug';
