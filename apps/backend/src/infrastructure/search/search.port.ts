import type { TenantId } from '../../common/keyspace';
import type { HealthCheckable } from '../capability';

/**
 * Search — full-text indexing and querying.
 *
 * Tenancy is enforced by the port:
 *   - every indexed document gets a `tenantId` field set from the tenantId
 *     argument (callers cannot set it themselves);
 *   - a document's identity is (tenantId, id), so remove() of one tenant can
 *     never delete another tenant's document with the same id;
 *   - every query is filtered by tenantId, and the field is stripped from the
 *     returned hits.
 */
export const SEARCH = Symbol('SEARCH');

/** Field the port owns on every indexed document. */
export const SEARCH_TENANT_FIELD = 'tenantId';

export type SearchDocument = Record<string, unknown>;

export type SearchFieldType =
  | 'keyword'
  | 'text'
  | 'integer'
  | 'long'
  | 'float'
  | 'boolean'
  | 'date';

export interface SearchFieldMapping {
  type: SearchFieldType;
  analyzer?: string;
}

export interface SearchQueryOptions {
  /** Fields to match, optionally boosted (`name^2`). */
  fields: string[];
  /** Tolerate typos (edit-distance matching). */
  fuzzy?: boolean;
  from?: number;
  size?: number;
}

export interface SearchResult<T> {
  hits: T[];
  total: number;
}

export interface SearchPort extends HealthCheckable {
  /** Creates the index when missing; the tenant field is always mapped. */
  ensureIndex(
    index: string,
    fields: Record<string, SearchFieldMapping>,
  ): Promise<void>;
  /** Inserts or replaces the tenant's document `id`. */
  index(
    tenantId: TenantId,
    index: string,
    id: string,
    doc: SearchDocument,
  ): Promise<void>;
  /** Removes the tenant's document `id`; removing an absent one succeeds. */
  remove(tenantId: TenantId, index: string, id: string): Promise<void>;
  /** Full-text query over the tenant's documents only. */
  query<T extends SearchDocument = SearchDocument>(
    tenantId: TenantId,
    index: string,
    text: string,
    options: SearchQueryOptions,
  ): Promise<SearchResult<T>>;
}

/** Adapter-facing query: the tenant filter is always present. */
export interface SearchEngineQuery {
  text: string;
  fields: string[];
  fuzzy: boolean;
  from: number;
  size: number;
  filter: { field: string; value: string };
}

/**
 * Adapter-facing contract. SearchClient builds document ids, adds the tenant
 * field and the tenant filter, so engines only translate.
 */
export interface SearchEngine extends HealthCheckable {
  ensureIndex(
    index: string,
    fields: Record<string, SearchFieldMapping>,
  ): Promise<void>;
  put(index: string, docId: string, doc: SearchDocument): Promise<void>;
  delete(index: string, docId: string): Promise<void>;
  search(
    index: string,
    query: SearchEngineQuery,
  ): Promise<SearchResult<SearchDocument>>;
}

export const SEARCH_ADAPTERS = ['elasticsearch', 'disabled'] as const;
export type SearchAdapterName = (typeof SEARCH_ADAPTERS)[number];
