-- 0012 finish 0011: future sequences and functions must not be handed to the Neon Data API roles either. Skipped where the roles do not exist.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anonymous', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END $$;
