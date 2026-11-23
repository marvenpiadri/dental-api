-- 0014 the Worker's runtime role (0013 named an earlier role that Neon created with admin rights; it is no longer used) `dontalist_rt`: data changes only, no DDL, no ownership. Skipped where the role does not exist (tests, other branches).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dontalist_rt') THEN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO dontalist_rt', current_database());
    GRANT USAGE ON SCHEMA public TO dontalist_rt;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dontalist_rt;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dontalist_rt;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dontalist_rt;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO dontalist_rt;
    REVOKE ALL ON TABLE schema_migration FROM dontalist_rt;
  END IF;
END $$;
