import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { selectAdapter } from '../capability';
import { ClickHouseOlapEngine } from './adapters/clickhouse/clickhouse-olap.engine';
import { DisabledOlapAdapter } from './adapters/disabled/disabled-olap.adapter';
import { OlapClient } from './olap.client';
import { OlapHealthIndicator } from './olap.health';
import { OLAP, OLAP_ADAPTERS, type OlapPort } from './olap.port';

/** Provides OLAP (OlapPort), adapter chosen by OLAP_ADAPTER. */
@Module({})
export class OlapModule {
  private static root?: DynamicModule;

  static forRoot(): DynamicModule {
    return (OlapModule.root ??= {
      module: OlapModule,
      providers: [
        {
          provide: OLAP,
          inject: [ConfigService],
          useFactory: (config: ConfigService): OlapPort => {
            const adapter = selectAdapter(
              'OLAP_ADAPTER',
              config.get<string>('OLAP_ADAPTER'),
              OLAP_ADAPTERS,
              'clickhouse',
            );
            if (adapter === 'disabled') return new DisabledOlapAdapter();
            return new OlapClient(
              new ClickHouseOlapEngine({
                url: config.getOrThrow<string>('CLICKHOUSE_HOST'),
                username: config.getOrThrow<string>('CLICKHOUSE_USER'),
                password: config.get<string>('CLICKHOUSE_PASSWORD', ''),
                database: config.getOrThrow<string>('CLICKHOUSE_DATABASE'),
              }),
            );
          },
        },
        OlapHealthIndicator,
      ],
      exports: [OLAP, OlapHealthIndicator],
    });
  }
}
