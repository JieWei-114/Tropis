import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ElasticsearchService } from '@nestjs/elasticsearch';

export interface IndexableDocument {
  id: string;
  [key: string]: unknown;
}

@Injectable()
export class SearchService implements OnModuleInit {
  private readonly logger = new Logger(SearchService.name);

  constructor(private readonly es: ElasticsearchService) {}

  async onModuleInit() {
    try {
      const info = await this.es.info();
      this.logger.log(
        `Elasticsearch connected — cluster: ${info.cluster_name}`,
      );
    } catch {
      this.logger.warn(
        'Elasticsearch not reachable on startup — search unavailable',
      );
    }
  }

  async ensureIndex(
    index: string,
    mappings?: Record<string, unknown>,
  ): Promise<void> {
    const exists = await this.es.indices.exists({ index });
    if (!exists) {
      await this.es.indices.create({ index, body: { mappings } });
      this.logger.log(`Created index: ${index}`);
    }
  }

  async index(index: string, doc: IndexableDocument): Promise<void> {
    await this.es.index({ index, id: doc.id, document: doc });
  }

  async bulkIndex(index: string, docs: IndexableDocument[]): Promise<void> {
    if (!docs.length) return;
    const operations = docs.flatMap((doc) => [
      { index: { _index: index, _id: doc.id } },
      doc,
    ]);
    const { errors } = await this.es.bulk({ operations });
    if (errors) this.logger.warn(`Bulk index to "${index}" had partial errors`);
  }

  async search<T = unknown>(
    index: string,
    query: Record<string, unknown>,
    options: { from?: number; size?: number } = {},
  ): Promise<{ hits: T[]; total: number }> {
    const result = await this.es.search<T>({
      index,
      from: options.from ?? 0,
      size: options.size ?? 10,
      query,
    });

    const total =
      typeof result.hits.total === 'number'
        ? result.hits.total
        : (result.hits.total?.value ?? 0);

    return {
      hits: result.hits.hits.map((h) => h._source as T),
      total,
    };
  }

  /**
   * Deletes a document, treating "not there" as success.
   *
   * Without `ignore: [404]` this throws for any id that was never indexed (an
   * earlier indexing failure, or a redelivered delete), which turns an
   * already-satisfied delete into a permanent handler failure.
   */
  async delete(index: string, id: string): Promise<void> {
    await this.es.delete({ index, id }, { ignore: [404] });
  }

  async deleteIndex(index: string): Promise<void> {
    const exists = await this.es.indices.exists({ index });
    if (exists) await this.es.indices.delete({ index });
  }
}
