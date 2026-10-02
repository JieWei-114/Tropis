import { execFileSync } from 'child_process';
import { resolve } from 'path';
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

const BACKEND = resolve(__dirname, '../..');

/**
 * The pgvector engine against a database whose schema comes only from
 * apps/backend/migrations, as in a deployment; and against an unmigrated
 * database, where the engine must stay schema-neutral and report down.
 */
describeWithDocker('Vector conformance (pgvector)')(
  'Vector conformance (pgvector)',
  () => {
    let container: StartedContainer;
    let admin: DataSource;
    let migrated: DataSource;
    let client: VectorClient;

    const connect = (database: string) =>
      new DataSource({
        type: 'postgres',
        host: container.host,
        port: container.port(5432),
        username: 'postgres',
        password: 'conformance',
        database,
      }).initialize();

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
            admin = await connect('conformance');
            return true;
          },
          120_000,
          container,
        ),
      );
      await admin.query(`CREATE DATABASE migrated`);
      execFileSync(
        process.execPath,
        [
          resolve(
            BACKEND,
            'node_modules/node-pg-migrate/bin/node-pg-migrate.js',
          ),
          '-m',
          'migrations',
          'up',
        ],
        {
          cwd: BACKEND,
          env: {
            ...process.env,
            DATABASE_URL: `postgres://postgres:conformance@${container.host}:${container.port(5432)}/migrated`,
          },
          stdio: 'pipe',
        },
      );
      migrated = await connect('migrated');
      client = new VectorClient(
        new PgvectorVectorEngine(new TypeOrmRelationalAdapter(migrated)),
      );
      await client.onModuleInit();
    });

    afterAll(async () => {
      await migrated?.destroy();
      await admin?.destroy();
      await container?.stop();
    });

    it('reports up over the migrated schema', async () => {
      await expect(client.health()).resolves.toEqual({
        status: 'up',
        adapter: 'pgvector',
      });
    });

    describeVectorPort('pgvector', { make: () => client });

    it('creates nothing on an unmigrated database and reports down', async () => {
      const engine = new PgvectorVectorEngine(
        new TypeOrmRelationalAdapter(admin),
      );
      await engine.onModuleInit();
      const tables = await admin.query<{ tablename: string }[]>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
      );
      expect(tables).toEqual([]);
      const health = await engine.health();
      expect(health.status).toBe('down');
      expect(health.message).toMatch(
        /vector_embeddings.*missing.*make migrate/,
      );
    });
  },
);
