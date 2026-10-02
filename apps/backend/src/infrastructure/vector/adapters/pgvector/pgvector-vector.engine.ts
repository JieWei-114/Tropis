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
const POLICY = 'tenant_isolation';
const MIGRATE_HINT = 'run the relational migrations (make migrate)';

interface SchemaRow {
  dim: number | null;
  rls: boolean;
  forced: boolean;
  policy: boolean;
}

const toPgVector = (embedding: number[]): string => `[${embedding.join(',')}]`;

function fromPgVector(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map(Number);
  return String(raw)
    .replace(/^\[|\]$/g, '')
    .split(',')
    .filter((part) => part.length > 0)
    .map(Number);
}

function schemaProblem(row: SchemaRow | undefined): string | undefined {
  if (!row) return `table ${TABLE} is missing`;
  if (row.dim === null) return `${TABLE}.embedding column is missing`;
  if (Number(row.dim) !== VECTOR_DIMENSIONS) {
    return `${TABLE}.embedding has width ${row.dim}, expected ${VECTOR_DIMENSIONS}`;
  }
  if (!row.rls || !row.forced) {
    return `${TABLE} is not under forced row-level security`;
  }
  if (!row.policy) return `${TABLE} has no ${POLICY} policy`;
  return undefined;
}

/**
 * VectorEngine over pgvector, through the relational capability's
 * connection. One table holds every collection; its primary key
 * (tenant_id, collection, id) makes the tenant part of item identity. The
 * table is under tenant row-level security and every statement runs inside
 * RelationalPort.withTenant(), so the database itself admits only the
 * tenant's rows; the explicit tenant_id predicates stay for the index.
 *
 * The engine never changes the schema: apps/backend/migrations is the single
 * schema source, so the runtime user needs no DDL privilege and two replicas
 * never race on a migration. Init and health verify the migrated table, its
 * embedding width and its row-level security, and report `down` naming the
 * migration step until they match.
 *
 * Why pgvector here: the vectors sit next to relational data, so filtered
 * similarity ("similar users who are also active") is a WHERE clause rather
 * than a second system.
 */
export class PgvectorVectorEngine implements VectorEngine, OnModuleInit {
  private readonly logger = createLogger('vector');
  private schemaVerified = false;

  constructor(private readonly db: RelationalPort) {}

  async onModuleInit(): Promise<void> {
    try {
      const problem = await this.verifySchema();
      if (problem) {
        this.logger.warn(
          'schema-missing',
          `Vector schema not ready: ${problem}; ${MIGRATE_HINT}`,
          { 'db.collection.name': TABLE },
        );
        return;
      }
      this.logger.info('table-ready', 'Vector table ready', {
        'db.collection.name': TABLE,
      });
    } catch (err) {
      this.logger.warn(
        'init-failed',
        'Vector schema check failed; similarity search is unavailable',
        { 'db.collection.name': TABLE },
        err,
      );
    }
  }

  private async verifySchema(): Promise<string | undefined> {
    const rows = await this.db.query<SchemaRow & Record<string, unknown>>(
      `SELECT c.relrowsecurity      AS rls,
              c.relforcerowsecurity AS forced,
              (SELECT a.atttypmod FROM pg_attribute a
               WHERE  a.attrelid = c.oid AND a.attname = 'embedding'
                 AND  NOT a.attisdropped) AS dim,
              EXISTS (SELECT 1 FROM pg_policy p
                      WHERE p.polrelid = c.oid AND p.polname = $2) AS policy
       FROM   pg_class c
       WHERE  c.oid = to_regclass($1)`,
      [TABLE, POLICY],
    );
    const problem = schemaProblem(rows[0]);
    this.schemaVerified = problem === undefined;
    return problem;
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
    return probeCapability('pgvector', async () => {
      if (this.schemaVerified) {
        await this.db.query(`SELECT 1 FROM ${TABLE} LIMIT 1`);
        return;
      }
      const problem = await this.verifySchema();
      if (problem) throw new Error(`${problem}; ${MIGRATE_HINT}`);
    });
  }
}
