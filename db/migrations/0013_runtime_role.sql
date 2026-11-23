-- 0013 the Worker's runtime role `dontalist_app`: data changes only, no DDL, no ownership. Skipped where the role does not exist (tests, other branches).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dontalist_app') THEN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO dontalist_app', current_database());
    GRANT USAGE ON SCHEMA public TO dontalist_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dontalist_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dontalist_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dontalist_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO dontalist_app;
    REVOKE ALL ON TABLE schema_migration FROM dontalist_app;
  END IF;
END $$;
