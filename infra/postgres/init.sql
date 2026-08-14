-- Enable pgvector extension for similarity search
CREATE EXTENSION IF NOT EXISTS vector;

-- Example: documents table with 1536-dim OpenAI embedding vectors
-- Actual tables are created by TypeORM migrations at app startup
CREATE TABLE IF NOT EXISTS documents (
  id          SERIAL PRIMARY KEY,
  content     TEXT        NOT NULL,
  embedding   vector(1536),
  metadata    JSONB       DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- IVFFlat index for approximate nearest-neighbour search
-- lists=100 is a reasonable default for < 1M rows
CREATE INDEX IF NOT EXISTS documents_embedding_idx
  ON documents USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Notification deliveries recorded by the Temporal worker (recordDelivery activity).
-- (workflow_id, run_id) is unique so a retried activity is idempotent.
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id          SERIAL PRIMARY KEY,
  workflow_id TEXT        NOT NULL,
  run_id      TEXT        NOT NULL,
  user_id     TEXT        NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (workflow_id, run_id)
);
