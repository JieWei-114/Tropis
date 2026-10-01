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
