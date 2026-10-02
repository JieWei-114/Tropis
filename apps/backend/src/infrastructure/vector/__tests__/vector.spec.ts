import { toTenantId } from '../../../common/keyspace';
import { DisabledVectorAdapter } from '../adapters/disabled/disabled-vector.adapter';
import { PgvectorVectorEngine } from '../adapters/pgvector/pgvector-vector.engine';
import type { RelationalPort } from '../../relational/relational.port';
import { CapabilityDisabledError } from '../../capability';
import { VectorClient, VectorValidationError } from '../vector.client';
import type { VectorPort } from '../vector.port';
import { InMemoryVectorEngine } from './in-memory-vector.engine';
import { axisVector, describeVectorPort } from './vector.conformance';

describeVectorPort('VectorClient over in-memory engine', {
  make: () => new VectorClient(new InMemoryVectorEngine()),
});

describe('VectorClient validation', () => {
  const client = new VectorClient(new InMemoryVectorEngine());
  const T = toTenantId('acme');

  it('rejects an unbranded, malformed tenant id', async () => {
    await expect(
      client.get('bad tenant' as never, 'users', 'a'),
    ).rejects.toBeInstanceOf(VectorValidationError);
  });

  it('rejects a collection that is not kebab-case', async () => {
    await expect(client.get(T, 'Users_1', 'a')).rejects.toBeInstanceOf(
      VectorValidationError,
    );
  });

  it('bounds k', async () => {
    await expect(
      client.similar(T, 'users', axisVector(0), 0),
    ).rejects.toBeInstanceOf(VectorValidationError);
    await expect(
      client.similar(T, 'users', axisVector(0), 101),
    ).rejects.toBeInstanceOf(VectorValidationError);
  });
});

describe('PgvectorVectorEngine', () => {
  const rows: { sql: string; params?: unknown[]; tenant?: string }[] = [];
  const record =
    (tenant?: string) =>
    <R>(sql: string, params?: unknown[]): Promise<R[]> => {
      rows.push({ sql, params, tenant });
      return Promise.resolve([]);
    };
  const db = {
    query: record(),
    withTenant: <T>(
      tenantId: string,
      fn: (tx: { query: ReturnType<typeof record> }) => Promise<T>,
    ) => fn({ query: record(tenantId) }),
    enableTenantIsolation: () => Promise.resolve(),
    health: () => Promise.resolve({ status: 'up', adapter: 'test' }),
  } as unknown as RelationalPort;
  const acme = toTenantId('acme');
  const engine = new PgvectorVectorEngine(db);

  beforeEach(() => (rows.length = 0));

  it('runs every statement in the tenant transaction and filters on tenant_id', async () => {
    await engine.upsert(acme, 'users', 'a', axisVector(0), {});
    await engine.get(acme, 'users', 'a');
    await engine.similar(acme, 'users', axisVector(0), 5, []);
    await engine.delete(acme, 'users', 'a');

    expect(rows).toHaveLength(4);
    for (const { sql, params, tenant } of rows) {
      expect(tenant).toBe('acme');
      expect(params).toContain('acme');
      if (!sql.startsWith('INSERT')) expect(sql).toMatch(/tenant_id = \$\d/);
    }
  });

  it('makes the tenant part of the upsert conflict target', async () => {
    await engine.upsert(acme, 'users', 'a', axisVector(0), {});
    expect(rows[0].sql).toContain('ON CONFLICT (tenant_id, collection, id)');
  });

  describe('schema verification', () => {
    const schemaRow = {
      dim: 384,
      rls: true,
      forced: true,
      policy: true,
    };
    const engineOver = (row: Record<string, unknown> | undefined) => {
      const statements: string[] = [];
      const fake = {
        query: (sql: string) => {
          statements.push(sql);
          return Promise.resolve(row ? [row] : []);
        },
        withTenant: () => Promise.resolve([]),
        enableTenantIsolation: () =>
          Promise.reject(new Error('runtime DDL is not allowed')),
        health: () => Promise.resolve({ status: 'up', adapter: 'test' }),
      } as unknown as RelationalPort;
      return { engine: new PgvectorVectorEngine(fake), statements };
    };

    it('issues no DDL on init', async () => {
      const { engine: e, statements } = engineOver(schemaRow);
      await e.onModuleInit();
      expect(statements.length).toBeGreaterThan(0);
      for (const sql of statements) {
        expect(sql).not.toMatch(/\b(CREATE|ALTER|DROP|TRUNCATE|GRANT)\b/i);
      }
    });

    it('reports up when the migrated table, width and RLS are present', async () => {
      const { engine: e } = engineOver(schemaRow);
      await e.onModuleInit();
      await expect(e.health()).resolves.toEqual({
        status: 'up',
        adapter: 'pgvector',
      });
    });

    it.each([
      ['the table is missing', undefined, /vector_embeddings.*missing/],
      [
        'row-level security is off',
        { ...schemaRow, rls: false },
        /row-level security/,
      ],
      [
        'row-level security is not forced',
        { ...schemaRow, forced: false },
        /row-level security/,
      ],
      [
        'the tenant policy is missing',
        { ...schemaRow, policy: false },
        /tenant_isolation/,
      ],
      ['the embedding width differs', { ...schemaRow, dim: 768 }, /768.*384/],
    ])(
      'reports down naming the migration step when %s',
      async (_, row, why) => {
        const { engine: e } = engineOver(row);
        await expect(e.onModuleInit()).resolves.toBeUndefined();
        const health = await e.health();
        expect(health.status).toBe('down');
        expect(health.adapter).toBe('pgvector');
        expect(health.message).toMatch(why);
        expect(health.message).toMatch(/make migrate/);
      },
    );

    it('turns up once the migrations have been applied', async () => {
      const row: { current?: Record<string, unknown> } = {};
      const fake = {
        query: () => Promise.resolve(row.current ? [row.current] : []),
      } as unknown as RelationalPort;
      const e = new PgvectorVectorEngine(fake);
      await e.onModuleInit();
      expect((await e.health()).status).toBe('down');
      row.current = schemaRow;
      expect((await e.health()).status).toBe('up');
    });
  });

  it('degrades init failures to a warning', async () => {
    const failing = new PgvectorVectorEngine({
      query: () => Promise.reject(new Error('no pgvector')),
      health: () => Promise.resolve({ status: 'down', adapter: 'test' }),
    } as unknown as RelationalPort);
    await expect(failing.onModuleInit()).resolves.toBeUndefined();
  });
});

describe('DisabledVectorAdapter', () => {
  it('rejects calls with CapabilityDisabledError and reports disabled', async () => {
    const adapter: VectorPort = new DisabledVectorAdapter();
    await expect(
      adapter.get(toTenantId('acme'), 'users', 'a'),
    ).rejects.toBeInstanceOf(CapabilityDisabledError);
    await expect(adapter.health()).resolves.toMatchObject({
      status: 'disabled',
    });
  });
});
