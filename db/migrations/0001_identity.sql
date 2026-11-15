-- 0001 identity. TiDB (MySQL dialect). No triggers, no ENUM, no CHECK reliance, no foreign keys until T0 proves enforcement on the target cluster.
-- Times are UTC DATETIME(3). Ids are VARCHAR(64) (the frontend's UUIDs are preserved).
CREATE TABLE IF NOT EXISTS clinic (
  id          VARCHAR(64)  NOT NULL PRIMARY KEY,
  name        VARCHAR(200) NOT NULL,
  timezone    VARCHAR(64)  NOT NULL DEFAULT 'Africa/Casablanca',
  created_at  DATETIME(3)  NOT NULL
);

CREATE TABLE IF NOT EXISTS staff (
  id             VARCHAR(64)  NOT NULL PRIMARY KEY,
  clinic_id      VARCHAR(64)  NOT NULL,
  email_norm     VARCHAR(254) NOT NULL,
  name           VARCHAR(200) NOT NULL,
  role           VARCHAR(16)  NOT NULL,
  job_title      VARCHAR(100) NULL,
  password_hash  VARCHAR(255) NOT NULL,
  failed_logins  INT          NOT NULL DEFAULT 0,
  locked_until   DATETIME(3)  NULL,
  suspended_at   DATETIME(3)  NULL,
  suspended_reason VARCHAR(500) NULL,
  created_at     DATETIME(3)  NOT NULL,
  UNIQUE KEY uq_staff_email (email_norm),
  KEY ix_staff_clinic (clinic_id, id)
);

-- Owner-made changes to a role's defaults (the frontend's `extra` / `removed`).
CREATE TABLE IF NOT EXISTS staff_permission (
  clinic_id   VARCHAR(64) NOT NULL,
  staff_id    VARCHAR(64) NOT NULL,
  permission  VARCHAR(32) NOT NULL,
  kind        VARCHAR(8)  NOT NULL, -- 'extra' | 'removed'
  PRIMARY KEY (staff_id, permission)
);

-- Opaque server-side sessions: only the SHA-256 of the token is stored.
CREATE TABLE IF NOT EXISTS auth_session (
  token_hash   CHAR(64)    NOT NULL PRIMARY KEY,
  clinic_id    VARCHAR(64) NOT NULL,
  staff_id     VARCHAR(64) NOT NULL,
  created_at   DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  expires_at   DATETIME(3) NOT NULL, -- absolute
  revoked_at   DATETIME(3) NULL,
  KEY ix_session_staff (staff_id, revoked_at)
);

-- Append-only: the API only INSERTs here.
CREATE TABLE IF NOT EXISTS audit_event (
  id          VARCHAR(64)  NOT NULL PRIMARY KEY,
  clinic_id   VARCHAR(64)  NOT NULL,
  staff_id    VARCHAR(64)  NULL,
  action      VARCHAR(64)  NOT NULL,
  target_type VARCHAR(32)  NULL,
  target_id   VARCHAR(64)  NULL,
  detail      VARCHAR(1000) NULL,
  created_at  DATETIME(3)  NOT NULL,
  KEY ix_audit_clinic_time (clinic_id, created_at, id)
);
