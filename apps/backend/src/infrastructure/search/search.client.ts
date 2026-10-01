import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { isTenantId, type TenantId } from '../../common/keyspace';
import type { CapabilityHealth } from '../capability';
import {
  SEARCH_TENANT_FIELD,
  type SearchDocument,
  type SearchEngine,
  type SearchFieldMapping,
  type SearchPort,
  type SearchQueryOptions,
  type SearchResult,
} from './search.port';

export class SearchTenancyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchTenancyError';
  }
}

const INDEX_PATTERN = /^[a-z][a-z0-9_-]*$/;
const DEFAULT_SIZE = 10;

/** Document id inside the engine: tenant ids cannot contain ':', so this is unambiguous. */
export function searchDocumentId(tenantId: TenantId, id: string): string {
  return `${tenantId}:${id}`;
}

/** SearchPort over any SearchEngine; the single place tenancy is enforced. */
export class SearchClient
  implements SearchPort, OnModuleInit, OnApplicationShutdown
{
  private readonly declared = new Map<
    string,
    Record<string, SearchFieldMapping>
  >();
  private readonly ready = new Map<string, Promise<void>>();

  constructor(private readonly engine: SearchEngine) {}

  /** Lets the engine run its startup check; Nest calls hooks on this wrapper only. */
  async onModuleInit(): Promise<void> {
    await (this.engine as Partial<OnModuleInit>).onModuleInit?.();
  }

  /** Closes the engine's connections on shutdown. */
  async onApplicationShutdown(): Promise<void> {
    await (
      this.engine as Partial<OnApplicationShutdown>
    ).onApplicationShutdown?.();
  }

  /**
   * Declares the index mapping. Kept even when the engine call fails, so the
   * first write retries with it instead of letting the engine infer one.
   */
  ensureIndex(
    index: string,
    fields: Record<string, SearchFieldMapping>,
  ): Promise<void> {
    return this.guard(() => {
      assertIndex(index);
      this.declared.set(index, {
        ...fields,
        [SEARCH_TENANT_FIELD]: { type: 'keyword' },
      });
      this.ready.delete(index);
      return this.ensured(index);
    });
  }

  index(
    tenantId: TenantId,
    index: string,
    id: string,
    doc: SearchDocument,
  ): Promise<void> {
    return this.guard(async () => {
      assertScope(tenantId, index);
      assertId(id);
      if (Object.prototype.hasOwnProperty.call(doc, SEARCH_TENANT_FIELD)) {
        throw new SearchTenancyError(
          `'${SEARCH_TENANT_FIELD}' is set by the search port; do not pass it in the document`,
        );
      }
      await this.ensured(index);
      return this.engine.put(index, searchDocumentId(tenantId, id), {
        ...doc,
        [SEARCH_TENANT_FIELD]: tenantId,
      });
    });
  }

  remove(tenantId: TenantId, index: string, id: string): Promise<void> {
    return this.guard(() => {
      assertScope(tenantId, index);
      assertId(id);
      return this.engine.delete(index, searchDocumentId(tenantId, id));
    });
  }

  query<T extends SearchDocument = SearchDocument>(
    tenantId: TenantId,
    index: string,
    text: string,
    options: SearchQueryOptions,
  ): Promise<SearchResult<T>> {
    return this.guard(async () => {
      assertScope(tenantId, index);
      if (!options?.fields?.length) {
        throw new SearchTenancyError('Search query needs at least one field');
      }
      const result = await this.engine.search(index, {
        text,
        fields: options.fields,
        fuzzy: options.fuzzy ?? false,
        from: options.from ?? 0,
        size: options.size ?? DEFAULT_SIZE,
        filter: { field: SEARCH_TENANT_FIELD, value: tenantId },
      });
      return {
        total: result.total,
        hits: result.hits.map((hit) => {
          const { [SEARCH_TENANT_FIELD]: _tenant, ...rest } = hit;
          return rest as T;
        }),
      };
    });
  }

  health(): Promise<CapabilityHealth> {
    return this.engine.health();
  }

  /**
   * The index exists with the tenant field mapped as a keyword before any
   * write reaches it, so the engine never infers that mapping from a document.
   * Once per index and process; a failure is retried on the next write.
   */
  private ensured(index: string): Promise<void> {
    let pending = this.ready.get(index);
    if (!pending) {
      pending = this.engine
        .ensureIndex(
          index,
          this.declared.get(index) ?? {
            [SEARCH_TENANT_FIELD]: { type: 'keyword' },
          },
        )
        .catch((err: unknown) => {
          this.ready.delete(index);
          throw err;
        });
      this.ready.set(index, pending);
    }
    return pending;
  }

  private guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return fn();
    } catch (err) {
      return Promise.reject(err as Error);
    }
  }
}

function assertScope(tenantId: TenantId, index: string): void {
  if (!isTenantId(tenantId)) {
    throw new SearchTenancyError(
      `Invalid tenant id ${JSON.stringify(tenantId)}`,
    );
  }
  assertIndex(index);
}

function assertIndex(index: string): void {
  if (typeof index !== 'string' || !INDEX_PATTERN.test(index)) {
    throw new SearchTenancyError(
      `Index name ${JSON.stringify(index)} must be lowercase`,
    );
  }
}

function assertId(id: string): void {
  if (typeof id !== 'string' || id.length === 0) {
    throw new SearchTenancyError('Document id must be a non-empty string');
  }
}
