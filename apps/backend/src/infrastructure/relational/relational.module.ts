import { DynamicModule, Module } from '@nestjs/common';
import { TypeOrmRelationalModule } from './adapters/typeorm/typeorm-relational.module';
import { RelationalHealthIndicator } from './relational.health';

/**
 * Provides RELATIONAL (RelationalPort) over the TypeORM root connection.
 * TypeORM is the only adapter; a role opens the pool only when a module it
 * runs imports this (the vector capability's pgvector adapter does).
 */
@Module({})
export class RelationalModule {
  private static root?: DynamicModule;

  static forRoot(): DynamicModule {
    return (RelationalModule.root ??= {
      module: RelationalModule,
      imports: [TypeOrmRelationalModule],
      providers: [RelationalHealthIndicator],
      exports: [TypeOrmRelationalModule, RelationalHealthIndicator],
    });
  }
}
