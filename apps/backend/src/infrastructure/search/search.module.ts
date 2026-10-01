import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { selectAdapter } from '../capability';
import { DisabledSearchAdapter } from './adapters/disabled/disabled-search.adapter';
import { ElasticsearchSearchEngine } from './adapters/elasticsearch/elasticsearch-search.engine';
import { SearchClient } from './search.client';
import { SearchHealthIndicator } from './search.health';
import { SEARCH, SEARCH_ADAPTERS, type SearchPort } from './search.port';

/** Provides SEARCH (SearchPort), adapter chosen by SEARCH_ADAPTER. */
@Module({})
export class SearchModule {
  private static root?: DynamicModule;

  static forRoot(): DynamicModule {
    return (SearchModule.root ??= {
      module: SearchModule,
      providers: [
        {
          provide: SEARCH,
          inject: [ConfigService],
          useFactory: (config: ConfigService): SearchPort => {
            const adapter = selectAdapter(
              'SEARCH_ADAPTER',
              config.get<string>('SEARCH_ADAPTER'),
              SEARCH_ADAPTERS,
              'elasticsearch',
            );
            if (adapter === 'disabled') return new DisabledSearchAdapter();
            return new SearchClient(
              new ElasticsearchSearchEngine({
                node: config.getOrThrow('ELASTICSEARCH_NODE'),
                username:
                  config.get<string>('ELASTICSEARCH_USERNAME') || undefined,
                password: config.get<string>('ELASTICSEARCH_PASSWORD', ''),
              }),
            );
          },
        },
        SearchHealthIndicator,
      ],
      exports: [SEARCH, SearchHealthIndicator],
    });
  }
}
