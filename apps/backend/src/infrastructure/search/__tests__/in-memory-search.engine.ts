import { capabilityUp, type CapabilityHealth } from '../../capability';
import type {
  SearchDocument,
  SearchEngine,
  SearchEngineQuery,
  SearchResult,
} from '../search.port';

/**
 * Substring-matching engine for tests. It applies the tenant filter it is
 * given exactly like a real engine, so tenancy tests exercise SearchClient.
 */
export class InMemorySearchEngine implements SearchEngine {
  readonly indices = new Map<string, Map<string, SearchDocument>>();

  ensureIndex(index: string): Promise<void> {
    if (!this.indices.has(index)) this.indices.set(index, new Map());
    return Promise.resolve();
  }

  put(index: string, docId: string, doc: SearchDocument): Promise<void> {
    if (!this.indices.has(index)) this.indices.set(index, new Map());
    this.indices.get(index)!.set(docId, doc);
    return Promise.resolve();
  }

  delete(index: string, docId: string): Promise<void> {
    this.indices.get(index)?.delete(docId);
    return Promise.resolve();
  }

  search(
    index: string,
    query: SearchEngineQuery,
  ): Promise<SearchResult<SearchDocument>> {
    const text = query.text.toLowerCase();
    const fields = query.fields.map((f) => f.split('^')[0]);
    const hits = [...(this.indices.get(index)?.values() ?? [])].filter(
      (doc) =>
        doc[query.filter.field] === query.filter.value &&
        fields.some((f) => asText(doc[f]).toLowerCase().includes(text)),
    );
    return Promise.resolve({
      hits: hits.slice(query.from, query.from + query.size),
      total: hits.length,
    });
  }

  health(): Promise<CapabilityHealth> {
    return Promise.resolve(capabilityUp('memory'));
  }
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value as string | number | boolean | bigint);
}
