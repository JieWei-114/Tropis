import type { OnModuleInit } from '@nestjs/common';
import { isTenantId, type TenantId } from '../../common/keyspace';
import type { CapabilityHealth } from '../capability';
import {
  VECTOR_DIMENSIONS,
  type VectorEngine,
  type VectorMatch,
  type VectorMetadata,
  type VectorPort,
  type VectorSearchOptions,
} from './vector.port';

export class VectorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VectorValidationError';
  }
}

const COLLECTION_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const MAX_K = 100;

/** VectorPort over any VectorEngine; the single place its rules are enforced. */
export class VectorClient implements VectorPort, OnModuleInit {
  constructor(private readonly engine: VectorEngine) {}

  /** Lets the engine prepare its storage; Nest calls hooks on this wrapper only. */
  async onModuleInit(): Promise<void> {
    await (this.engine as Partial<OnModuleInit>).onModuleInit?.();
  }

  upsert(
    tenantId: TenantId,
    collection: string,
    id: string,
    embedding: number[],
    metadata: VectorMetadata = {},
  ): Promise<void> {
    return this.guard(() => {
      this.assertScope(tenantId, collection);
      assertId(id);
      assertEmbedding(embedding);
      return this.engine.upsert(tenantId, collection, id, embedding, metadata);
    });
  }

  get(
    tenantId: TenantId,
    collection: string,
    id: string,
  ): Promise<number[] | null> {
    return this.guard(() => {
      this.assertScope(tenantId, collection);
      assertId(id);
      return this.engine.get(tenantId, collection, id);
    });
  }

  similar(
    tenantId: TenantId,
    collection: string,
    embedding: number[],
    k: number,
    options: VectorSearchOptions = {},
  ): Promise<VectorMatch[]> {
    return this.guard(() => {
      this.assertScope(tenantId, collection);
      assertEmbedding(embedding);
      if (!Number.isInteger(k) || k <= 0 || k > MAX_K) {
        throw new VectorValidationError(
          `k must be an integer in 1..${MAX_K}, got ${k}`,
        );
      }
      const excludeIds = options.excludeIds ?? [];
      excludeIds.forEach(assertId);
      return this.engine.similar(
        tenantId,
        collection,
        embedding,
        k,
        excludeIds,
      );
    });
  }

  delete(tenantId: TenantId, collection: string, id: string): Promise<void> {
    return this.guard(() => {
      this.assertScope(tenantId, collection);
      assertId(id);
      return this.engine.delete(tenantId, collection, id);
    });
  }

  health(): Promise<CapabilityHealth> {
    return this.engine.health();
  }

  private assertScope(tenantId: TenantId, collection: string): void {
    if (!isTenantId(tenantId)) {
      throw new VectorValidationError(
        `Invalid tenant id ${JSON.stringify(tenantId)}`,
      );
    }
    if (
      typeof collection !== 'string' ||
      !COLLECTION_PATTERN.test(collection)
    ) {
      throw new VectorValidationError(
        `Collection ${JSON.stringify(collection)} must be lowercase kebab-case`,
      );
    }
  }

  private guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return fn();
    } catch (err) {
      return Promise.reject(err as Error);
    }
  }
}

function assertId(id: string): void {
  if (typeof id !== 'string' || id.length === 0) {
    throw new VectorValidationError(
      'Vector item id must be a non-empty string',
    );
  }
}

function assertEmbedding(embedding: number[]): void {
  if (
    !Array.isArray(embedding) ||
    embedding.length !== VECTOR_DIMENSIONS ||
    !embedding.every((v) => typeof v === 'number' && Number.isFinite(v))
  ) {
    throw new VectorValidationError(
      `Embedding must be ${VECTOR_DIMENSIONS} finite numbers`,
    );
  }
}
