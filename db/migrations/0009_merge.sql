-- 0009 patient merge: the surviving file the duplicate was folded into. The duplicate is archived, never deleted.
ALTER TABLE patient ADD COLUMN merged_into_id uuid;
ALTER TABLE patient ADD CONSTRAINT patient_merged_into_fk FOREIGN KEY (clinic_id, merged_into_id) REFERENCES patient (clinic_id, id);
ALTER TABLE patient ADD CONSTRAINT patient_merge_not_self CHECK (merged_into_id IS NULL OR merged_into_id <> id);
CREATE INDEX ix_patient_phone ON patient (clinic_id, phone) WHERE phone IS NOT NULL AND archived_at IS NULL;
