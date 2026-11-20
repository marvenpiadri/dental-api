-- 0001 identity (PostgreSQL). Native types; composite (clinic_id, id) keys so a row can never reference another clinic's row.
CREATE TABLE clinic (
  id         uuid PRIMARY KEY,
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  timezone   text NOT NULL DEFAULT 'Africa/Casablanca',
  currency   text NOT NULL DEFAULT 'MAD' CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL
);

CREATE TABLE staff (
  id               uuid PRIMARY KEY,
  clinic_id        uuid NOT NULL REFERENCES clinic (id),
  email_norm       text NOT NULL CHECK (email_norm = lower(email_norm) AND length(email_norm) <= 254),
  name             text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  role             text NOT NULL CHECK (role IN ('owner','admin','dentist','assistant','reception','accountant')),
  job_title        text CHECK (length(job_title) <= 100),
  password_hash    text NOT NULL,
  failed_logins    integer NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  locked_until     timestamptz,
  suspended_at     timestamptz,
  suspended_reason text CHECK (length(suspended_reason) <= 500),
  created_at       timestamptz NOT NULL,
  UNIQUE (email_norm),
  UNIQUE (clinic_id, id)
);

-- Owner-made changes to a role's defaults (the frontend's `extra` / `removed`).
CREATE TABLE staff_permission (
  clinic_id  uuid NOT NULL,
  staff_id   uuid NOT NULL,
  permission text NOT NULL CHECK (permission ~ '^[a-z]+\.[a-z]+$'),
  kind       text NOT NULL CHECK (kind IN ('extra','removed')),
  PRIMARY KEY (staff_id, permission),
  FOREIGN KEY (clinic_id, staff_id) REFERENCES staff (clinic_id, id) ON DELETE CASCADE
);

-- Opaque server-side sessions: only the SHA-256 of the token is stored.
CREATE TABLE auth_session (
  token_hash   text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  clinic_id    uuid NOT NULL,
  staff_id     uuid NOT NULL,
  created_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  FOREIGN KEY (clinic_id, staff_id) REFERENCES staff (clinic_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_session_staff ON auth_session (staff_id) WHERE revoked_at IS NULL;

CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000'; END $$;

-- Append-only: the API only INSERTs here, and the database refuses UPDATE/DELETE.
CREATE TABLE audit_event (
  id          uuid PRIMARY KEY,
  clinic_id   uuid NOT NULL REFERENCES clinic (id),
  staff_id    uuid,
  action      text NOT NULL CHECK (length(action) <= 64),
  target_type text CHECK (length(target_type) <= 32),
  target_id   uuid,
  detail      jsonb CHECK (jsonb_typeof(detail) = 'object'),
  created_at  timestamptz NOT NULL,
  FOREIGN KEY (clinic_id, staff_id) REFERENCES staff (clinic_id, id)
);
CREATE INDEX ix_audit_clinic_time ON audit_event (clinic_id, created_at DESC, id);
CREATE TRIGGER audit_event_append_only BEFORE UPDATE OR DELETE ON audit_event FOR EACH ROW EXECUTE FUNCTION forbid_change();
