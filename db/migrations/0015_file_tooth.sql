-- A patient picture or X-ray can be about one tooth (FDI number). Optional; set and cleared later.
ALTER TABLE file ADD COLUMN tooth text CHECK (tooth ~ '^[1-8][1-8]$');
-- The tooth label is the one thing about a stored clinical file that may still change (it is a filing label, not part of the record's content).
CREATE OR REPLACE FUNCTION guard_file() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE retained boolean := OLD.status = 'ready' AND OLD.purpose IN ('patient_document','xray','clinical_image','lab_attachment');
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF retained THEN RAISE EXCEPTION 'a stored clinical file cannot be deleted' USING ERRCODE = '55000'; END IF;
    RETURN OLD;
  END IF;
  IF retained AND (OLD.voided_at IS NOT NULL OR (to_jsonb(NEW) - 'voided_at' - 'void_reason' - 'tooth') IS DISTINCT FROM (to_jsonb(OLD) - 'voided_at' - 'void_reason' - 'tooth')) THEN
    RAISE EXCEPTION 'a stored clinical file can only be voided' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
