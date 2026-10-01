import { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Client } from '@elastic/elasticsearch';
import { createLogger } from '../../../../common/observability/logger';
import { probeCapability, type CapabilityHealth } from '../../../capability';
import type {
  SearchDocument,
  SearchEngine,
  SearchEngineQuery,
  SearchFieldMapping,
  SearchResult,
} from '../../search.port';
import { SEARCH_TENANT_FIELD } from '../../search.port';

const TENANT_TEMPLATE = {
  tenant_keyword: {
    match: SEARCH_TENANT_FIELD,
    mapping: { type: 'keyword' as const },
  },
};

function errorType(err: unknown): string | undefined {
  return (err as { meta?: { body?: { error?: { type?: string } } } }).meta?.body
    ?.error?.type;
}

export interface ElasticsearchOptions {
  node: string;
  username?: string;
  password?: string;
}

export class ElasticsearchSearchEngine
  implements SearchEngine, OnModuleInit, OnApplicationShutdown
{
  private readonly logger = createLogger('search');
  private readonly es: Client;

  constructor(options: ElasticsearchOptions, client?: Client) {
    this.es =
      client ??
      new Client({
        node: options.node,
        auth: options.username
          ? { username: options.username, password: options.password ?? '' }
          : undefined,
        maxRetries: 3,
        requestTimeout: 10_000,
      });
  }

  async onModuleInit(): Promise<void> {
    try {
      const info = await this.es.info();
      this.logger.info('connected', 'Elasticsearch connected', {
        'db.elasticsearch.cluster.name': info.cluster_name,
      });
    } catch (err) {
      this.logger.warn(
        'unreachable',
        'Elasticsearch is not reachable on startup; search is unavailable',
        {},
        err,
      );
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.es.close().catch(() => undefined);
  }

  /**
   * Creates the index with an explicit mapping, or adds missing fields to an
   * existing one. A dynamic template keeps the tenant field a keyword even
   * where a mapping update is skipped, and an index whose tenant field is
   * mapped otherwise is refused: a text field would let the tenant filter
   * match on tokens (`acme` inside `acme-corp`).
   */
  async ensureIndex(
    index: string,
    fields: Record<string, SearchFieldMapping>,
  ): Promise<void> {
    const exists = await this.es.indices.exists({ index });
    if (!exists) {
      const created = await this.es.indices
        .create({
          index,
          mappings: {
            dynamic_templates: [TENANT_TEMPLATE],
            properties: fields,
          },
        })
        .then(() => true)
        .catch((err: unknown) => {
          if (errorType(err) === 'resource_already_exists_exception') {
            return false;
          }
          throw err;
        });
      if (created) {
        this.logger.info('index-created', 'Search index created', {
          'search.index': index,
        });
        return;
      }
    }
    // An index created before a field existed gets the field added; a field
    // that already exists with another type is left alone (and logged).
    await this.es.indices
      .putMapping({
        index,
        dynamic_templates: [TENANT_TEMPLATE],
        properties: fields,
      })
      .catch((err: unknown) =>
        this.logger.warn(
          'mapping-not-updated',
          'Search index mapping not updated',
          { 'search.index': index },
          err,
        ),
      );
    await this.assertTenantKeyword(index);
  }

  private async assertTenantKeyword(index: string): Promise<void> {
    const mapping = await this.es.indices.getMapping({ index });
    for (const [name, entry] of Object.entries(mapping)) {
      const tenant = entry.mappings?.properties?.[SEARCH_TENANT_FIELD] as
        | { type?: string }
        | undefined;
      if (tenant?.type !== 'keyword') {
        throw new Error(
          `Search index ${name} maps ${SEARCH_TENANT_FIELD} as ${tenant?.type ?? 'nothing'}, not keyword; writes are refused until it is reindexed`,
        );
      }
    }
  }

  async put(index: string, docId: string, doc: SearchDocument): Promise<void> {
    await this.es.index({ index, id: docId, document: doc });
  }

  /**
   * Treats "not there" as success: without `ignore: [404]` a delete of a
   * never-indexed id (an earlier indexing failure, a redelivered delete)
   * turns an already-satisfied delete into a permanent handler failure.
   */
  async delete(index: string, docId: string): Promise<void> {
    await this.es.delete({ index, id: docId }, { ignore: [404] });
  }

  async search(
    index: string,
    query: SearchEngineQuery,
  ): Promise<SearchResult<SearchDocument>> {
    const result = await this.es.search<SearchDocument>({
      index,
      from: query.from,
      size: query.size,
      query: {
        bool: {
          must: {
            multi_match: {
              query: query.text,
              fields: query.fields,
              ...(query.fuzzy ? { fuzziness: 'AUTO' } : {}),
            },
          },
          filter: { term: { [query.filter.field]: query.filter.value } },
        },
      },
    });

    const total =
      typeof result.hits.total === 'number'
        ? result.hits.total
        : (result.hits.total?.value ?? 0);

    return {
      hits: result.hits.hits
        .map((h) => h._source)
        .filter((s): s is SearchDocument => s !== undefined),
      total,
    };
  }

  health(): Promise<CapabilityHealth> {
    return probeCapability('elasticsearch', () => this.es.ping());
  }
}
