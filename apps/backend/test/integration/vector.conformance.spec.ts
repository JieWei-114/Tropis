import { DataSource } from 'typeorm';
import { TypeOrmRelationalAdapter } from '../../src/infrastructure/relational/adapters/typeorm/typeorm-relational.adapter';
import { PgvectorVectorEngine } from '../../src/infrastructure/vector/adapters/pgvector/pgvector-vector.engine';
import { VectorClient } from '../../src/infrastructure/vector/vector.client';
import { describeVectorPort } from '../../src/infrastructure/vector/__tests__/vector.conformance';
import { describeWithDocker } from './docker';
import {
  readyOrStop,
  startContainer,
  waitUntil,
  type StartedContainer,
} from './containers';

jest.setTimeout(240_000);

describeWithDocker('Vector conformance (pgvector)')(
  'Vector conformance (pgvector)',
  () => {
    let container: StartedContainer;
    let dataSource: DataSource;
    let client: VectorClient;

    beforeAll(async () => {
      container = startContainer({
        image: 'pgvector/pgvector:pg16',
        label: 'pgvector',
        ports: [5432],
        env: { POSTGRES_PASSWORD: 'conformance', POSTGRES_DB: 'conformance' },
      });
      await readyOrStop(container, () =>
        waitUntil(
          'postgres',
          async () => {
            const candidate = new DataSource({
              type: 'postgres',
              host: container.host,
              port: container.port(5432),
              username: 'postgres',
              password: 'conformance',
              database: 'conformance',
            });
            await candidate.initialize();
            await candidate.query('SELECT 1');
            dataSource = candidate;
            return true;
          },
          120_000,
          container,
        ),
      );
      client = new VectorClient(
        new PgvectorVectorEngine(new TypeOrmRelationalAdapter(dataSource)),
      );
      await client.onModuleInit();
    });

    afterAll(async () => {
      await dataSource?.destroy();
      await container?.stop();
    });

    describeVectorPort('pgvector', { make: () => client });
  },
);
