import { execFileSync } from 'child_process';
import { resolve } from 'path';
import { DataSource } from 'typeorm';
import { toTenantId } from '../../src/common/keyspace';
import { TypeOrmRelationalAdapter } from '../../src/infrastructure/relational/adapters/typeorm/typeorm-relational.adapter';
import { describeRelationalPort } from '../../src/infrastructure/relational/__tests__/relational.conformance';
import { describeWithDocker } from './docker';
import {
  readyOrStop,
  startContainer,
  waitUntil,
  type StartedContainer,
} from './containers';

jest.setTimeout(240_000);

const BACKEND = resolve(__dirname, '../..');

const connect = (
  container: StartedContainer,
  user: string,
  password: string,
  database = 'conformance',
) =>
  new DataSource({
    type: 'postgres',
    host: container.host,
    port: container.port(5432),
    username: user,
    password,
    database,
  }).initialize();

/**
 * The relational port against a real Postgres, as a superuser (which
 * bypasses RLS unless withTenant switches role) and as an ordinary owner role
 * like a deployment's application user; then the migrations in
 * apps/backend/migrations on an empty database.
 */
describeWithDocker('Relational conformance (postgres)')(
  'Relational conformance (postgres)',
  () => {
    let container: StartedContainer;
    let admin: DataSource;
    let app: DataSource;

    beforeAll(async () => {
      container = startContainer({
        image: 'pgvector/pgvector:pg16',
        label: 'postgres-rls',
        ports: [5432],
        env: { POSTGRES_PASSWORD: 'conformance', POSTGRES_DB: 'conformance' },
      });
      await readyOrStop(container, () =>
        waitUntil(
          'postgres',
          async () => {
            admin = await connect(container, 'postgres', 'conformance');
            return true;
          },
          120_000,
          container,
        ),
      );
      await admin.query(
        `CREATE ROLE app_user LOGIN PASSWORD 'app' NOSUPERUSER CREATEROLE`,
      );
      await admin.query(`GRANT ALL ON SCHEMA public TO app_user`);
      // As infra/postgres/init.sql does for the application user.
      await admin.query(`CREATE ROLE tropis_tenant_scope NOLOGIN`);
      await admin.query(`GRANT tropis_tenant_scope TO app_user`);
      app = await connect(container, 'app_user', 'app');
    });

    afterAll(async () => {
      await app?.destroy();
      await admin?.destroy();
      await container?.stop();
    });

    describeRelationalPort(
      'typeorm (superuser)',
      { make: () => new TypeOrmRelationalAdapter(admin) },
      { fencedOutsideTenant: false },
    );

    describeRelationalPort(
      'typeorm (application owner)',
      { make: () => new TypeOrmRelationalAdapter(app) },
      { fencedOutsideTenant: true },
    );

    describe('migrations', () => {
      let db: DataSource;

      const migrate = (...args: string[]) =>
        execFileSync(
          process.execPath,
          [
            resolve(
              BACKEND,
              'node_modules/node-pg-migrate/bin/node-pg-migrate.js',
            ),
            '-m',
            'migrations',
            ...args,
          ],
          {
            cwd: BACKEND,
            env: {
              ...process.env,
              DATABASE_URL: `postgres://postgres:conformance@${container.host}:${container.port(5432)}/migrations`,
            },
            stdio: 'pipe',
          },
        );

      beforeAll(async () => {
        await admin.query(`CREATE DATABASE migrations`);
        migrate('up');
        db = await connect(container, 'postgres', 'conformance', 'migrations');
      });

      afterAll(async () => {
        await db?.destroy();
      });

      it('creates only the tables code reads, under forced tenant RLS', async () => {
        const tables = await db.query<{ tablename: string }[]>(
          `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
        );
        expect(tables.map((t) => t.tablename)).toEqual([
          'pgmigrations',
          'vector_embeddings',
        ]);
        const [rls] = await db.query<{ enabled: boolean; forced: boolean }[]>(
          `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
           FROM pg_class WHERE relname = 'vector_embeddings'`,
        );
        expect(rls).toEqual({ enabled: true, forced: true });
      });

      it('isolates tenants on the migrated table', async () => {
        const port = new TypeOrmRelationalAdapter(db);
        const A = toTenantId('tenant-a');
        const B = toTenantId('tenant-b');
        const vector = `[${Array.from({ length: 384 }, () => 0.1).join(',')}]`;
        await port.withTenant(A, (tx) =>
          tx.query(
            `INSERT INTO vector_embeddings (tenant_id, collection, id, embedding)
             VALUES ($1, 'c', 'x', $2::vector)`,
            [A, vector],
          ),
        );
        const seen = await port.withTenant(B, (tx) =>
          tx.query(`SELECT id FROM vector_embeddings`),
        );
        expect(seen).toEqual([]);
      });

      it('rolls back and re-applies cleanly', async () => {
        await db.destroy();
        migrate('down', '2');
        migrate('up');
        db = await connect(container, 'postgres', 'conformance', 'migrations');
        const [policy] = await db.query<{ n: string }[]>(
          `SELECT count(*) AS n FROM pg_policies WHERE tablename = 'vector_embeddings'`,
        );
        expect(Number(policy?.n)).toBe(1);
      });
    });
  },
);
