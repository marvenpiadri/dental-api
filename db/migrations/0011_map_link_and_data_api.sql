-- 0011 a patient can carry a Google Maps location link (exactly https://maps.google.com/?ll=<lat>,<lng>), and the Neon Data API roles get no access to clinic data.
ALTER TABLE patient ADD COLUMN map_url text CHECK (map_url ~ '^https://maps\.google\.com/\?ll=-?[0-9]{1,3}(\.[0-9]{1,10})?,-?[0-9]{1,3}(\.[0-9]{1,10})?$');

-- Neon's Data API runs requests as `anonymous` / `authenticated` and grants the latter every table. Our API is the only door (it enforces clinic isolation and
-- permissions); these roles have no row-level security to fall back on, so they must hold no privileges. Skipped where the roles do not exist.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anonymous', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
    END IF;
  END LOOP;
END $$;
