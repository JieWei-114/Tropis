/**
 * Initial schema: the pgvector extension and vector_embeddings, the one
 * table the vector capability (PgvectorVectorEngine) stores every
 * collection in.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql('CREATE EXTENSION IF NOT EXISTS vector;');
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS vector_embeddings (
      tenant_id  TEXT        NOT NULL,
      collection TEXT        NOT NULL,
      id         TEXT        NOT NULL,
      embedding  vector(384) NOT NULL,
      metadata   JSONB       NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, collection, id)
    );
  `);
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS vector_embeddings_embedding_idx
    ON vector_embeddings USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 10);
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS vector_embeddings;');
};
