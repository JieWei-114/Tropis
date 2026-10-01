/**
 * Tenancy: the tropis_tenant_scope role and tenant row-level security on
 * vector_embeddings. The statements match tenantIsolationStatements() in the
 * relational capability's TypeORM adapter.
 */

const POLICY_PREDICATE = "tenant_id = current_setting('app.tenant_id', true)";

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tropis_tenant_scope') THEN
        CREATE ROLE tropis_tenant_scope NOLOGIN;
      END IF;
    END $$;
  `);
  pgm.sql(`
    DO $$ BEGIN
      IF NOT pg_has_role(current_user, 'tropis_tenant_scope', 'MEMBER') THEN
        EXECUTE 'GRANT tropis_tenant_scope TO ' || quote_ident(current_user);
      END IF;
    END $$;
  `);
  pgm.sql('GRANT USAGE ON SCHEMA public TO tropis_tenant_scope;');
  pgm.sql(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON vector_embeddings TO tropis_tenant_scope;',
  );
  pgm.sql('ALTER TABLE vector_embeddings ENABLE ROW LEVEL SECURITY;');
  pgm.sql('ALTER TABLE vector_embeddings FORCE ROW LEVEL SECURITY;');
  pgm.sql(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'vector_embeddings' AND policyname = 'tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON vector_embeddings
          USING (${POLICY_PREDICATE}) WITH CHECK (${POLICY_PREDICATE});
      END IF;
    END $$;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql('DROP POLICY IF EXISTS tenant_isolation ON vector_embeddings;');
  pgm.sql('ALTER TABLE vector_embeddings NO FORCE ROW LEVEL SECURITY;');
  pgm.sql('ALTER TABLE vector_embeddings DISABLE ROW LEVEL SECURITY;');
  pgm.sql(
    'REVOKE SELECT, INSERT, UPDATE, DELETE ON vector_embeddings FROM tropis_tenant_scope;',
  );
};
