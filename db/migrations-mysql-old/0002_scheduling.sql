-- 0002 scheduling. Same rules as 0001 (no FK/CHECK reliance until tests/tidb T0 proves them on the target cluster; tenant isolation is enforced in every query).
CREATE TABLE IF NOT EXISTS patient (
  id          VARCHAR(64)  NOT NULL PRIMARY KEY,
  clinic_id   VARCHAR(64)  NOT NULL,
  full_name   VARCHAR(200) NOT NULL,
  full_name_norm VARCHAR(200) NOT NULL, -- lowercase, accent-free copy: search and sort never depend on the DB collation (TiDB defaults to case-sensitive)
  phone       VARCHAR(40)  NULL,
  email       VARCHAR(254) NULL,
  birth_date  DATE         NULL,
  sex         VARCHAR(8)   NULL,
  country     VARCHAR(64)  NULL,
  city        VARCHAR(100) NULL,
  alert       VARCHAR(500) NULL,
  notes       VARCHAR(2000) NULL,
  created_at  DATETIME(3)  NOT NULL,
  archived_at DATETIME(3)  NULL,
  KEY ix_patient_clinic_name (clinic_id, full_name_norm, id)
);

CREATE TABLE IF NOT EXISTS chair (
  id VARCHAR(64) NOT NULL PRIMARY KEY, clinic_id VARCHAR(64) NOT NULL, name VARCHAR(100) NOT NULL, color VARCHAR(16) NULL, archived_at DATETIME(3) NULL,
  KEY ix_chair_clinic (clinic_id, id)
);

CREATE TABLE IF NOT EXISTS dentist_profile (
  id VARCHAR(64) NOT NULL PRIMARY KEY, clinic_id VARCHAR(64) NOT NULL, staff_id VARCHAR(64) NULL, name VARCHAR(200) NOT NULL,
  specialty VARCHAR(100) NULL, color VARCHAR(16) NULL, phone VARCHAR(40) NULL, email VARCHAR(254) NULL, registration VARCHAR(64) NULL, archived_at DATETIME(3) NULL,
  KEY ix_dentist_clinic (clinic_id, id)
);

-- status values (frontend contract): scheduled, confirmed, arrived, in-progress, completed, cancelled, no-show.
-- live = 0 while the booking is being created (claims may exist but the appointment is not visible/valid); 1 once every slot claim succeeded.
CREATE TABLE IF NOT EXISTS appointment (
  id VARCHAR(64) NOT NULL PRIMARY KEY, clinic_id VARCHAR(64) NOT NULL,
  patient_id VARCHAR(64) NOT NULL, dentist_id VARCHAR(64) NOT NULL, chair_id VARCHAR(64) NOT NULL,
  start_at DATETIME(3) NOT NULL, end_at DATETIME(3) NOT NULL,
  status VARCHAR(16) NOT NULL, live TINYINT NOT NULL DEFAULT 0, version INT NOT NULL DEFAULT 1,
  notes VARCHAR(2000) NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
  KEY ix_appt_clinic_start (clinic_id, start_at, id),
  KEY ix_appt_dentist_start (clinic_id, dentist_id, start_at),
  KEY ix_appt_patient_start (clinic_id, patient_id, start_at)
);

-- The double-booking guard: the primary key makes a second claim of the same 5-minute slot fail with a duplicate-key error.
CREATE TABLE IF NOT EXISTS appointment_slot (
  clinic_id VARCHAR(64) NOT NULL, resource_kind VARCHAR(8) NOT NULL, resource_id VARCHAR(64) NOT NULL, slot_start DATETIME(3) NOT NULL,
  appointment_id VARCHAR(64) NOT NULL, claimed_at DATETIME(3) NOT NULL,
  PRIMARY KEY (clinic_id, resource_kind, resource_id, slot_start),
  KEY ix_slot_appt (appointment_id)
);

CREATE TABLE IF NOT EXISTS appointment_status_change (
  id VARCHAR(64) NOT NULL PRIMARY KEY, clinic_id VARCHAR(64) NOT NULL, appointment_id VARCHAR(64) NOT NULL,
  from_status VARCHAR(16) NULL, to_status VARCHAR(16) NOT NULL, staff_id VARCHAR(64) NULL, reason VARCHAR(500) NULL, at DATETIME(3) NOT NULL,
  KEY ix_asc_appt (clinic_id, appointment_id, at)
);
