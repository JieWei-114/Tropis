import { OnModuleInit } from '@nestjs/common';
import { probeCapability, type CapabilityHealth } from '../../../capability';
import type { TenantId } from '../../../../common/keyspace';
import { createLogger } from '../../../../common/observability/logger';
import type { RelationalPort } from '../../../relational/relational.port';
import {
  VECTOR_DIMENSIONS,
  type VectorEngine,
  type VectorMatch,
  type VectorMetadata,
} from '../../vector.port';

const TABLE = 'vector_embeddings';
const INDEX = 'vector_embeddings_embedding_idx';

const toPgVector = (embedding: number[]): string => `[${embedding.join(',')}]`;

function fromPgVector(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map(Number);
  return String(raw)
    .replace(/^\[|\]$/g, '')
    .split(',')
    .filter((part) => part.length > 0)
    .map(Number);
}

/**
 * VectorEngine over pgvector, through the relational capability's
 * connection. One table holds every collection; its primary key
 * (tenant_id, collection, id) makes the tenant part of item identity. The
 * table is under tenant row-level security and every statement runs inside
 * RelationalPort.withTenant(), so the database itself admits only the
 * tenant's rows; the explicit tenant_id predicates stay for the index.
 *
 * Why pgvector here: the vectors sit next to relational data, so filtered
 * similarity ("similar users who are also active") is a WHERE clause rather
 * than a second system.
 */
export class PgvectorVectorEngine implements VectorEngine, OnModuleInit {
  private readonly logger = createLogger('vector');

  constructor(private readonly db: RelationalPort) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.db.query(`CREATE EXTENSION IF NOT EXISTS vector`);
      await this.db.query(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          tenant_id  TEXT NOT NULL,
          collection TEXT NOT NULL,
          id         TEXT NOT NULL,
          embedding  vector(${VECTOR_DIMENSIONS}) NOT NULL,
          metadata   JSONB NOT NULL DEFAULT '{}',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (tenant_id, collection, id)
        )
      `);
      // CREATE TABLE IF NOT EXISTS cannot correct an embedding column of a
      // different width, and every upsert would then fail on a dimension
      // mismatch. Reconcile the width before indexing.
      await this.ensureEmbeddingWidth();
      await this.db.enableTenantIsolation(TABLE);
      await this.db.query(`
        CREATE INDEX IF NOT EXISTS ${INDEX}
        ON ${TABLE}
        USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 10)
      `);
      this.logger.info('table-ready', 'Vector table ready', {
        'db.collection.name': TABLE,
      });
    } catch (err) {
      this.logger.warn(
        'init-failed',
        'Vector table init failed; similarity search is unavailable',
        { 'db.collection.name': TABLE },
        err,
      );
    }
  }

  /**
   * Brings an existing `embedding` column to VECTOR_DIMENSIONS.
   *
   * pgvector cannot change a column's dimension in place while data is
   * present, and stored vectors are derived (not source data), so the rows
   * are dropped and repopulated on the next upsert.
   */
  private async ensureEmbeddingWidth(): Promise<void> {
    const rows = await this.db.query<{ dim: number }>(
      `SELECT atttypmod AS dim
       FROM   pg_attribute
       WHERE  attrelid = '${TABLE}'::regclass AND attname = 'embedding'`,
    );
    const current = rows[0]?.dim;
    if (current === undefined || current === VECTOR_DIMENSIONS) return;

    this.logger.warn(
      'embedding-width-migrated',
      'Embedding column width differs; truncating and migrating',
      {
        'db.collection.name': TABLE,
        'vector.dimensions.current': current,
        'vector.dimensions.target': VECTOR_DIMENSIONS,
      },
    );
    await this.db.query(`DROP INDEX IF EXISTS ${INDEX}`);
    await this.db.query(`TRUNCATE ${TABLE}`);
    await this.db.query(
      `ALTER TABLE ${TABLE} ALTER COLUMN embedding TYPE vector(${VECTOR_DIMENSIONS})`,
    );
  }

  async upsert(
    tenantId: TenantId,
    collection: string,
    id: string,
    embedding: number[],
    metadata: VectorMetadata,
  ): Promise<void> {
    await this.db.withTenant(tenantId, (tx) =>
      tx.query(
        `INSERT INTO ${TABLE} (tenant_id, collection, id, embedding, metadata, updated_at)
       VALUES ($1, $2, $3, $4::vector, $5::jsonb, now())
       ON CONFLICT (tenant_id, collection, id) DO UPDATE
         SET embedding = EXCLUDED.embedding,
             metadata = EXCLUDED.metadata,
             updated_at = now()`,
        [
          tenantId,
          collection,
          id,
          toPgVector(embedding),
          JSON.stringify(metadata),
        ],
      ),
    );
  }

  async get(
    tenantId: TenantId,
    collection: string,
    id: string,
  ): Promise<number[] | null> {
    const rows = await this.db.withTenant(tenantId, (tx) =>
      tx.query<{ embedding: unknown }>(
        `SELECT embedding FROM ${TABLE}
         WHERE tenant_id = $1 AND collection = $2 AND id = $3`,
        [tenantId, collection, id],
      ),
    );
    return rows.length ? fromPgVector(rows[0].embedding) : null;
  }

  async similar(
    tenantId: TenantId,
    collection: string,
    embedding: number[],
    k: number,
    excludeIds: string[],
  ): Promise<VectorMatch[]> {
    // ORDER BY a constant probe vector keeps the query index-eligible; a
    // self-join comparing two columns cannot use the ivfflat index.
    const rows = await this.db.withTenant(tenantId, (tx) =>
      tx.query<{
        id: string;
        distance: string | number;
        metadata: VectorMetadata | null;
      }>(
        `SELECT id, (embedding <=> $1::vector) AS distance, metadata
         FROM   ${TABLE}
         WHERE  tenant_id = $2 AND collection = $3 AND NOT (id = ANY($4::text[]))
         ORDER  BY embedding <=> $1::vector
         LIMIT  $5`,
        [toPgVector(embedding), tenantId, collection, excludeIds, k],
      ),
    );
    return rows.map((r) => ({
      id: r.id,
      distance: Number(r.distance),
      metadata: r.metadata ?? {},
    }));
  }

  async delete(
    tenantId: TenantId,
    collection: string,
    id: string,
  ): Promise<void> {
    await this.db.withTenant(tenantId, (tx) =>
      tx.query(
        `DELETE FROM ${TABLE} WHERE tenant_id = $1 AND collection = $2 AND id = $3`,
        [tenantId, collection, id],
      ),
    );
  }

  health(): Promise<CapabilityHealth> {
    return probeCapability('pgvector', () =>
      this.db.query(`SELECT 1 FROM ${TABLE} LIMIT 1`),
    );
  }
}
