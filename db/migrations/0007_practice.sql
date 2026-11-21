-- 0007 practice management: expenses, stock with a ledger, lab orders, tasks, implants, sterilization cycles, equipment.
CREATE TABLE expense (
  id          uuid PRIMARY KEY,
  clinic_id   uuid NOT NULL REFERENCES clinic (id),
  day         date NOT NULL,
  label       text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 200),
  amount      numeric(12,2) NOT NULL CHECK (amount > 0),
  category    text CHECK (category IN ('rent','salaries','supplies','lab','equipment','utilities','taxes','other')),
  created_at  timestamptz NOT NULL,
  created_by  uuid,
  voided_at   timestamptz,
  void_reason text CHECK (length(void_reason) <= 500),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX ix_expense_day ON expense (clinic_id, day DESC, id DESC) WHERE voided_at IS NULL;

CREATE TABLE stock_item (
  id          uuid PRIMARY KEY,
  clinic_id   uuid NOT NULL REFERENCES clinic (id),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  qty         integer NOT NULL DEFAULT 0 CHECK (qty >= 0),   -- changed only by stock movements
  min_qty     integer NOT NULL DEFAULT 0 CHECK (min_qty >= 0),
  unit        text CHECK (length(unit) <= 20),
  expires     date,
  supplier    text CHECK (length(supplier) <= 200),
  archived_at timestamptz,
  UNIQUE (clinic_id, id)
);
CREATE INDEX ix_stock_name ON stock_item (clinic_id, name, id) WHERE archived_at IS NULL;
-- The ledger. change is signed, after is the balance once applied. The sum of an item's changes always equals its qty.
CREATE TABLE stock_movement (
  id         uuid PRIMARY KEY,
  clinic_id  uuid NOT NULL,
  item_id    uuid NOT NULL,
  day        date NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('in','out','waste','adjust','opening')),
  change     integer NOT NULL CHECK (change <> 0),
  after      integer NOT NULL CHECK (after >= 0),
  reason     text CHECK (length(reason) <= 300),
  staff_id   uuid,
  at         timestamptz NOT NULL,
  FOREIGN KEY (clinic_id, item_id) REFERENCES stock_item (clinic_id, id),
  FOREIGN KEY (clinic_id, staff_id) REFERENCES staff (clinic_id, id)
);
CREATE INDEX ix_stockmove ON stock_movement (item_id, at DESC, id DESC);
CREATE TRIGGER stock_movement_append_only BEFORE UPDATE OR DELETE ON stock_movement FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE lab_order (
  id         uuid PRIMARY KEY,
  clinic_id  uuid NOT NULL,
  patient_id uuid NOT NULL,
  work       text NOT NULL CHECK (length(btrim(work)) BETWEEN 1 AND 200),
  lab        text NOT NULL CHECK (length(btrim(lab)) BETWEEN 1 AND 200),
  due        date NOT NULL,
  status     text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','ready','fitted','remake','cancelled')),
  tooth      text CHECK (tooth ~ '^[1-8][1-8]$'),
  shade      text CHECK (length(shade) <= 20),
  cost       numeric(12,2) CHECK (cost >= 0),
  created_at timestamptz NOT NULL,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patient (clinic_id, id)
);
CREATE INDEX ix_lab_due ON lab_order (clinic_id, due, id);
CREATE INDEX ix_lab_patient ON lab_order (clinic_id, patient_id, created_at DESC);
-- Fitted and cancelled orders are closed.
CREATE FUNCTION guard_lab_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('fitted','cancelled') THEN RAISE EXCEPTION 'a closed lab order cannot be changed' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lab_order_guard BEFORE UPDATE ON lab_order FOR EACH ROW EXECUTE FUNCTION guard_lab_order();
CREATE TABLE lab_event (
  id        uuid PRIMARY KEY,
  clinic_id uuid NOT NULL,
  order_id  uuid NOT NULL,
  day       date NOT NULL,
  status    text NOT NULL,
  staff_id  uuid,
  note      text CHECK (length(note) <= 500),
  at        timestamptz NOT NULL,
  FOREIGN KEY (clinic_id, order_id) REFERENCES lab_order (clinic_id, id)
);
CREATE INDEX ix_labevent ON lab_event (order_id, at, id);
CREATE TRIGGER lab_event_append_only BEFORE UPDATE OR DELETE ON lab_event FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE task (
  id         uuid PRIMARY KEY,
  clinic_id  uuid NOT NULL REFERENCES clinic (id),
  text       text NOT NULL CHECK (length(btrim(text)) BETWEEN 1 AND 500),
  done       boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  created_by uuid
);
CREATE INDEX ix_task ON task (clinic_id, done, created_at, id);

-- Which implant (brand, lot) went into which tooth: needed if a lot is ever recalled. Never edited.
CREATE TABLE implant_record (
  id         uuid PRIMARY KEY,
  clinic_id  uuid NOT NULL,
  patient_id uuid NOT NULL,
  tooth      text NOT NULL CHECK (tooth ~ '^[1-8][1-8]$'),
  brand      text NOT NULL CHECK (length(btrim(brand)) BETWEEN 1 AND 100),
  lot        text NOT NULL CHECK (length(btrim(lot)) BETWEEN 1 AND 60),
  day        date NOT NULL,
  created_at timestamptz NOT NULL,
  created_by uuid,
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patient (clinic_id, id)
);
CREATE INDEX ix_implant_lot ON implant_record (clinic_id, lot, id);
CREATE INDEX ix_implant_patient ON implant_record (clinic_id, patient_id, day DESC);
CREATE TRIGGER implant_append_only BEFORE UPDATE OR DELETE ON implant_record FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE sterilization_cycle (
  id         uuid PRIMARY KEY,
  clinic_id  uuid NOT NULL REFERENCES clinic (id),
  day        date NOT NULL,
  device     text NOT NULL CHECK (length(btrim(device)) BETWEEN 1 AND 100),
  lot        text NOT NULL CHECK (length(btrim(lot)) BETWEEN 1 AND 60),
  operator   text NOT NULL CHECK (length(btrim(operator)) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL
);
CREATE INDEX ix_steril ON sterilization_cycle (clinic_id, day DESC, id DESC);
CREATE TRIGGER steril_append_only BEFORE UPDATE OR DELETE ON sterilization_cycle FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE equipment (
  id           uuid PRIMARY KEY,
  clinic_id    uuid NOT NULL REFERENCES clinic (id),
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  serial       text CHECK (length(serial) <= 100),
  location     text CHECK (length(location) <= 100),
  every_months integer CHECK (every_months BETWEEN 1 AND 120),
  last_service date,
  archived_at  timestamptz,
  UNIQUE (clinic_id, id)
);
CREATE INDEX ix_equipment ON equipment (clinic_id, name, id) WHERE archived_at IS NULL;
CREATE TABLE equipment_service (
  id           uuid PRIMARY KEY,
  clinic_id    uuid NOT NULL,
  equipment_id uuid NOT NULL,
  day          date NOT NULL,
  note         text CHECK (length(note) <= 500),
  at           timestamptz NOT NULL,
  FOREIGN KEY (clinic_id, equipment_id) REFERENCES equipment (clinic_id, id)
);
CREATE INDEX ix_eqservice ON equipment_service (equipment_id, day DESC, id DESC);
CREATE TRIGGER eqservice_append_only BEFORE UPDATE OR DELETE ON equipment_service FOR EACH ROW EXECUTE FUNCTION forbid_change();
