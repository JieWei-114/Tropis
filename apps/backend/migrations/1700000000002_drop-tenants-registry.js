/**
 * Drops the relational `tenants` table. The tenant registry is the documents
 * store's `tenants` collection (TenantDirectory); nothing references this
 * table, and two registries would drift apart. Row-level security does not
 * depend on it.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS tenants;');
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS tenants (
      id          TEXT        PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'),
      name        TEXT        NOT NULL DEFAULT '',
      status      TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
};
