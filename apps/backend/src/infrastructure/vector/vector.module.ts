import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { selectAdapter } from '../capability';
import { importWhenSelected } from '../capability/conditional-import';
import { RelationalModule } from '../relational/relational.module';
import { RELATIONAL, type RelationalPort } from '../relational/relational.port';
import { DisabledVectorAdapter } from './adapters/disabled/disabled-vector.adapter';
import { PgvectorVectorEngine } from './adapters/pgvector/pgvector-vector.engine';
import { VectorClient } from './vector.client';
import { VectorHealthIndicator } from './vector.health';
import { VECTOR, VECTOR_ADAPTERS, type VectorPort } from './vector.port';

/**
 * Provides VECTOR (VectorPort), adapter chosen by VECTOR_ADAPTER. The
 * pgvector adapter runs on the relational capability's connection, which is
 * imported only when pgvector is selected.
 */
@Module({})
export class VectorModule {
  private static root?: DynamicModule;

  static forRoot(): DynamicModule {
    return (VectorModule.root ??= {
      module: VectorModule,
      imports: [
        importWhenSelected(
          'VECTOR_ADAPTER',
          'pgvector',
          'pgvector',
          RelationalModule.forRoot(),
        ),
      ],
      providers: [
        {
          provide: VECTOR,
          inject: [ConfigService, { token: RELATIONAL, optional: true }],
          useFactory: (
            config: ConfigService,
            relational?: RelationalPort,
          ): VectorPort => {
            const adapter = selectAdapter(
              'VECTOR_ADAPTER',
              config.get<string>('VECTOR_ADAPTER'),
              VECTOR_ADAPTERS,
              'pgvector',
            );
            if (adapter === 'disabled') return new DisabledVectorAdapter();
            if (!relational) {
              throw new Error(
                'VECTOR_ADAPTER=pgvector requires RelationalModule',
              );
            }
            return new VectorClient(new PgvectorVectorEngine(relational));
          },
        },
        VectorHealthIndicator,
      ],
      exports: [VECTOR, VectorHealthIndicator],
    });
  }
}
