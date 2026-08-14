/**
 * Migration: initial schema
 * Creates: user_vectors, documents tables
 * Run: pnpm migrate up
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  // pgvector extension (must be installed in the DB image)
  pgm.sql('CREATE EXTENSION IF NOT EXISTS vector;');

  // ── user_vectors ──────────────────────────────────────────────────────────
  pgm.createTable('user_vectors', {
    id:         { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id:    { type: 'text', notNull: true, unique: true },
    embedding:  { type: 'vector(384)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('user_vectors', 'user_id');
  // IVFFlat index for cosine similarity — rebuild after bulk inserts for best performance
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS user_vectors_embedding_idx
    ON user_vectors USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
  `);

  // ── documents ─────────────────────────────────────────────────────────────
  pgm.createTable('documents', {
    id:         { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id:    { type: 'text', notNull: true },
    bucket:     { type: 'text', notNull: true },
    object_key: { type: 'text', notNull: true },
    filename:   { type: 'text', notNull: true },
    mime_type:  { type: 'text' },
    size_bytes: { type: 'bigint' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('documents', 'user_id');
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable('documents');
  pgm.dropTable('user_vectors');
};
