import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { selectAdapter } from '../capability';
import { DisabledGraphAdapter } from './adapters/disabled/disabled-graph.adapter';
import { Neo4jGraphEngine } from './adapters/neo4j/neo4j-graph.engine';
import { GraphClient } from './graph.client';
import { GraphHealthIndicator } from './graph.health';
import { GRAPH, GRAPH_ADAPTERS, type GraphPort } from './graph.port';

/**
 * Provides GRAPH (GraphPort), adapter chosen by GRAPH_ADAPTER. Defaults to
 * `disabled` because the graph server is an optional compose profile.
 */
@Module({})
export class GraphModule {
  private static root?: DynamicModule;

  static forRoot(): DynamicModule {
    return (GraphModule.root ??= {
      module: GraphModule,
      providers: [
        {
          provide: GRAPH,
          inject: [ConfigService],
          useFactory: (config: ConfigService): GraphPort => {
            const adapter = selectAdapter(
              'GRAPH_ADAPTER',
              config.get<string>('GRAPH_ADAPTER'),
              GRAPH_ADAPTERS,
              'disabled',
            );
            if (adapter === 'disabled') return new DisabledGraphAdapter();
            return new GraphClient(
              new Neo4jGraphEngine({
                uri: config.getOrThrow<string>('NEO4J_URI'),
                user: config.getOrThrow<string>('NEO4J_USER'),
                password: config.get<string>('NEO4J_PASSWORD', ''),
              }),
            );
          },
        },
        GraphHealthIndicator,
      ],
      exports: [GRAPH, GraphHealthIndicator],
    });
  }
}
