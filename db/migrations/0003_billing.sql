-- 0003 billing (PostgreSQL). Money is numeric(12,2); the API computes in BigInt minor units.
-- Issued invoices are immutable (triggers): a mistake is cancelled with a credit note, never edited or deleted.
CREATE TABLE invoice (
  id            uuid PRIMARY KEY,
  clinic_id     uuid NOT NULL REFERENCES clinic (id),
  patient_id    uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('invoice','credit-note')),
  number_year   integer NOT NULL,
  seq           integer NOT NULL CHECK (seq > 0),
  number        text NOT NULL,                 -- FA-2026-0001 / AV-2026-0001
  issued_at     timestamptz NOT NULL,
  due_on        date,
  total         numeric(12,2) NOT NULL,
  currency      text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  cancels_id    uuid,                          -- a credit note points at the invoice it cancels
  cancelled_at  timestamptz,
  cancel_reason text CHECK (length(cancel_reason) <= 500),
  created_by    uuid,
  UNIQUE (clinic_id, id),
  UNIQUE (clinic_id, kind, number_year, seq),
  CHECK ((kind = 'invoice' AND total >= 0 AND cancels_id IS NULL) OR (kind = 'credit-note' AND total <= 0 AND cancels_id IS NOT NULL)),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patient (clinic_id, id),
  FOREIGN KEY (clinic_id, cancels_id) REFERENCES invoice (clinic_id, id),
  FOREIGN KEY (clinic_id, created_by) REFERENCES staff (clinic_id, id)
);
CREATE UNIQUE INDEX uq_one_credit_note_per_invoice ON invoice (cancels_id) WHERE kind = 'credit-note';
CREATE INDEX ix_invoice_patient ON invoice (clinic_id, patient_id, issued_at DESC, id DESC);

CREATE TABLE invoice_line (
  invoice_id uuid NOT NULL,
  position   integer NOT NULL CHECK (position >= 0),
  clinic_id  uuid NOT NULL,
  item_id    uuid,                              -- the treatment-plan item this line bills (kept as a plain reference: the plan arrives in P4)
  label      text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 300),
  where_text text CHECK (length(where_text) <= 100),
  price      numeric(12,2) NOT NULL,
  PRIMARY KEY (invoice_id, position),
  FOREIGN KEY (clinic_id, invoice_id) REFERENCES invoice (clinic_id, id)
);

CREATE TABLE payment (
  id          uuid PRIMARY KEY,
  clinic_id   uuid NOT NULL REFERENCES clinic (id),
  patient_id  uuid NOT NULL,
  invoice_id  uuid,                              -- absent = advance / payment on account
  amount      numeric(12,2) NOT NULL CHECK (amount > 0),
  method      text NOT NULL CHECK (method IN ('cash','card','transfer','cheque','other')),
  at          timestamptz NOT NULL,
  reference   text CHECK (length(reference) <= 100),
  note        text CHECK (length(note) <= 500),
  payer_type  text CHECK (length(payer_type) <= 32),
  payer_id    uuid,
  currency    text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  voided_at   timestamptz,
  void_reason text CHECK (length(void_reason) <= 500),
  created_by  uuid,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patient (clinic_id, id),
  FOREIGN KEY (clinic_id, invoice_id) REFERENCES invoice (clinic_id, id),
  FOREIGN KEY (clinic_id, created_by) REFERENCES staff (clinic_id, id)
);
CREATE INDEX ix_payment_patient ON payment (clinic_id, patient_id, at DESC, id DESC);
CREATE INDEX ix_payment_invoice ON payment (invoice_id);

-- Money handed back, recorded against the credit note that cancelled the invoice. Append-only.
CREATE TABLE refund (
  id             uuid PRIMARY KEY,
  clinic_id      uuid NOT NULL REFERENCES clinic (id),
  credit_note_id uuid NOT NULL,
  amount         numeric(12,2) NOT NULL CHECK (amount > 0),
  method         text NOT NULL CHECK (method IN ('cash','card','transfer','cheque','other')),
  at             timestamptz NOT NULL,
  reference      text CHECK (length(reference) <= 100),
  created_by     uuid,
  FOREIGN KEY (clinic_id, credit_note_id) REFERENCES invoice (clinic_id, id),
  FOREIGN KEY (clinic_id, created_by) REFERENCES staff (clinic_id, id)
);
CREATE INDEX ix_refund_note ON refund (credit_note_id);
CREATE TRIGGER refund_append_only BEFORE UPDATE OR DELETE ON refund FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER invoice_line_append_only BEFORE UPDATE OR DELETE ON invoice_line FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Only the cancellation fields (once) may change on an invoice; a payment may only be voided (once). Nothing is ever deleted.
CREATE FUNCTION guard_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'invoice is append-only' USING ERRCODE = '55000'; END IF;
  IF OLD.cancelled_at IS NOT NULL OR (to_jsonb(NEW) - 'cancelled_at' - 'cancel_reason') <> (to_jsonb(OLD) - 'cancelled_at' - 'cancel_reason') THEN
    RAISE EXCEPTION 'an issued invoice cannot be changed' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_guard BEFORE UPDATE OR DELETE ON invoice FOR EACH ROW EXECUTE FUNCTION guard_invoice();

CREATE FUNCTION guard_payment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'payment is append-only' USING ERRCODE = '55000'; END IF;
  IF OLD.voided_at IS NOT NULL OR (to_jsonb(NEW) - 'voided_at' - 'void_reason') <> (to_jsonb(OLD) - 'voided_at' - 'void_reason') THEN
    RAISE EXCEPTION 'a payment can only be voided, once' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_guard BEFORE UPDATE OR DELETE ON payment FOR EACH ROW EXECUTE FUNCTION guard_payment();
