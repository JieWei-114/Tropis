import type { TenantId } from '../../common/keyspace';
import type { HealthCheckable } from '../capability';

/**
 * Vector — embedding storage and nearest-neighbour search.
 *
 * Tenancy is enforced by the port: every item is stored under
 * (tenantId, collection, id), and every read, search and delete is filtered
 * by the tenantId argument, so one tenant's embeddings are never returned to
 * or removed by another. Distances are cosine distances (0 = identical).
 */
export const VECTOR = Symbol('VECTOR');

/** Width of every stored embedding. */
export const VECTOR_DIMENSIONS = 384;

export type VectorMetadata = Record<string, string | number | boolean | null>;

export interface VectorMatch {
  id: string;
  /** Cosine distance to the probe; lower is more similar. */
  distance: number;
  metadata: VectorMetadata;
}

export interface VectorSearchOptions {
  /** Ids left out of the result, e.g. the probe item itself. */
  excludeIds?: string[];
}

export interface VectorPort extends HealthCheckable {
  /** Inserts or replaces the item's embedding and metadata. */
  upsert(
    tenantId: TenantId,
    collection: string,
    id: string,
    embedding: number[],
    metadata?: VectorMetadata,
  ): Promise<void>;
  /** The stored embedding, or null when the item does not exist. */
  get(
    tenantId: TenantId,
    collection: string,
    id: string,
  ): Promise<number[] | null>;
  /** The `k` nearest items of the collection, nearest first. */
  similar(
    tenantId: TenantId,
    collection: string,
    embedding: number[],
    k: number,
    options?: VectorSearchOptions,
  ): Promise<VectorMatch[]>;
  /** Removes the item; removing an absent item succeeds. */
  delete(tenantId: TenantId, collection: string, id: string): Promise<void>;
}

/**
 * Adapter-facing contract. Arguments are already validated by VectorClient,
 * so engines only translate them; each must still filter on tenantId.
 */
export interface VectorEngine extends HealthCheckable {
  upsert(
    tenantId: TenantId,
    collection: string,
    id: string,
    embedding: number[],
    metadata: VectorMetadata,
  ): Promise<void>;
  get(
    tenantId: TenantId,
    collection: string,
    id: string,
  ): Promise<number[] | null>;
  similar(
    tenantId: TenantId,
    collection: string,
    embedding: number[],
    k: number,
    excludeIds: string[],
  ): Promise<VectorMatch[]>;
  delete(tenantId: TenantId, collection: string, id: string): Promise<void>;
}

export const VECTOR_ADAPTERS = ['pgvector', 'disabled'] as const;
export type VectorAdapterName = (typeof VECTOR_ADAPTERS)[number];
