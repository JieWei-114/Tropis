import { Module, Global } from '@nestjs/common';
import { ElasticsearchModule } from '@nestjs/elasticsearch';
import { ConfigService } from '@nestjs/config';
import { SearchService } from './search.service';

@Global()
@Module({
  imports: [
    ElasticsearchModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        node: config.get('ELASTICSEARCH_NODE', 'http://localhost:9200'),
        auth: config.get('ELASTICSEARCH_USERNAME')
          ? {
              username: config.get<string>('ELASTICSEARCH_USERNAME')!,
              password: config.get('ELASTICSEARCH_PASSWORD', ''),
            }
          : undefined,
        maxRetries: 3,
        requestTimeout: 10_000,
      }),
    }),
  ],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
