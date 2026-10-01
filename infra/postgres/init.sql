-- Runs once on a fresh compose volume, as the superuser. It only provides
-- what a migration user may lack the privilege to create; every table, grant
-- and policy comes from apps/backend/migrations (make migrate).
CREATE EXTENSION IF NOT EXISTS vector;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tropis_tenant_scope') THEN
    CREATE ROLE tropis_tenant_scope NOLOGIN;
  END IF;
END $$;
GRANT tropis_tenant_scope TO CURRENT_USER;
