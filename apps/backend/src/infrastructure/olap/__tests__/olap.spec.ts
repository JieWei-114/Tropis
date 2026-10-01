import { toTenantId } from '../../../common/keyspace';
import { CapabilityDisabledError } from '../../capability';
import { ClickHouseOlapEngine } from '../adapters/clickhouse/clickhouse-olap.engine';
import { DisabledOlapAdapter } from '../adapters/disabled/disabled-olap.adapter';
import { OlapClient, OlapTenancyError } from '../olap.client';
import type { OlapEngine, OlapParams, OlapRow } from '../olap.port';

class RecordingEngine implements OlapEngine {
  readonly inserts: { table: string; rows: readonly object[] }[] = [];
  readonly queries: { sql: string; params: OlapParams }[] = [];
  insert(table: string, rows: readonly object[]) {
    this.inserts.push({ table, rows });
    return Promise.resolve();
  }
  query(sql: string, params: OlapParams): Promise<OlapRow[]> {
    this.queries.push({ sql, params });
    return Promise.resolve([{ ok: 1 }]);
  }
  key = ['tenant_id', 'ts'];
  sortingKeyCalls = 0;
  sortingKey(): Promise<string[]> {
    this.sortingKeyCalls++;
    return Promise.resolve(this.key);
  }
  health() {
    return Promise.resolve({ status: 'up' as const, adapter: 'test' });
  }
}

describe('OlapClient', () => {
  const T = toTenantId('acme');
  let engine: RecordingEngine;
  let client: OlapClient;

  beforeEach(() => {
    engine = new RecordingEngine();
    client = new OlapClient(engine);
  });

  it('binds tenant_id from the TenantId argument', async () => {
    await client.query(T, 'SELECT 1 WHERE tenant_id = {tenant_id:String}', {
      days: 7,
    });
    expect(engine.queries[0].params).toEqual({ days: 7, tenant_id: 'acme' });
  });

  it('rejects SQL without the tenant placeholder', async () => {
    await expect(client.query(T, 'SELECT 1')).rejects.toBeInstanceOf(
      OlapTenancyError,
    );
    expect(engine.queries).toHaveLength(0);
  });

  it('ignores a placeholder inside a string literal', async () => {
    await expect(
      client.query(T, "SELECT '{tenant_id:String}'"),
    ).rejects.toBeInstanceOf(OlapTenancyError);
  });

  it('rejects a malformed tenant id', async () => {
    await expect(
      client.query(
        'x y' as never,
        'SELECT 1 WHERE tenant_id = {tenant_id:String}',
      ),
    ).rejects.toBeInstanceOf(OlapTenancyError);
  });

  it('skips empty inserts', async () => {
    await client.insert(T, 'logs.t', []);
    expect(engine.inserts).toHaveLength(0);
  });

  it('stamps the tenant on every inserted row', async () => {
    await client.insert(T, 'logs.t', [{ id: 1 }, { id: 2, tenant_id: 'acme' }]);
    expect(engine.inserts[0].rows).toEqual([
      { id: 1, tenant_id: 'acme' },
      { id: 2, tenant_id: 'acme' },
    ]);
  });

  it('rejects a row that names another tenant', async () => {
    await expect(
      client.insert(T, 'logs.t', [{ id: 1, tenant_id: 'globex' }]),
    ).rejects.toBeInstanceOf(OlapTenancyError);
    expect(engine.inserts).toHaveLength(0);
  });

  it('checks the leading key once per table', async () => {
    await client.insert(T, 'logs.t', [{ id: 1 }]);
    await client.insert(T, 'logs.t', [{ id: 2 }]);
    expect(engine.sortingKeyCalls).toBe(1);
  });

  it('refuses tenant rows in a table not keyed by tenant_id first', async () => {
    engine.key = ['ts', 'tenant_id'];
    await expect(
      client.insert(T, 'logs.t', [{ id: 1 }]),
    ).rejects.toBeInstanceOf(OlapTenancyError);
    engine.key = ['tenant_id'];
    await expect(client.insert(T, 'logs.t', [{ id: 1 }])).resolves.toBe(
      undefined,
    );
  });

  it('requires a tenant_id equality predicate, not a bare placeholder', async () => {
    await expect(
      client.query(T, "SELECT 1 WHERE {tenant_id:String} != ''"),
    ).rejects.toBeInstanceOf(OlapTenancyError);
    await expect(
      client.query(
        T,
        'SELECT 1 FROM t AS e WHERE e.tenant_id = {tenant_id:String}',
      ),
    ).resolves.toEqual([{ ok: 1 }]);
  });

  it('inserts global rows unchanged', async () => {
    await client.insertGlobal('logs.g', [{ id: 1 }]);
    expect(engine.inserts[0].rows).toEqual([{ id: 1 }]);
  });
});

describe('ClickHouseOlapEngine', () => {
  const ch = {
    insert: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(),
    ping: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const engine = new ClickHouseOlapEngine(
    { url: 'http://unused', username: 'u', password: '', database: 'd' },
    ch as never,
  );

  beforeEach(() => jest.clearAllMocks());

  it('inserts JSONEachRow through the async-insert buffer, waiting for the flush', async () => {
    await engine.insert('logs.t', [{ a: 1 }]);
    expect(ch.insert).toHaveBeenCalledWith({
      table: 'logs.t',
      values: [{ a: 1 }],
      format: 'JSONEachRow',
      clickhouse_settings: { async_insert: 1, wait_for_async_insert: 1 },
    });
  });

  it('queries with bound parameters and returns rows', async () => {
    ch.query.mockResolvedValue({ json: () => Promise.resolve([{ a: 1 }]) });
    await expect(engine.query('SELECT {x:Int32}', { x: 1 })).resolves.toEqual([
      { a: 1 },
    ]);
    expect(ch.query).toHaveBeenCalledWith({
      query: 'SELECT {x:Int32}',
      query_params: { x: 1 },
      format: 'JSONEachRow',
    });
  });

  it('reads the sorting key from system.tables', async () => {
    ch.query.mockResolvedValue({
      json: () =>
        Promise.resolve([{ sorting_key: 'tenant_id, event_type, ts' }]),
    });
    await expect(engine.sortingKey('logs.t')).resolves.toEqual([
      'tenant_id',
      'event_type',
      'ts',
    ]);
    expect(ch.query.mock.calls[0][0].query_params).toEqual({
      database: 'logs',
      name: 't',
    });
  });

  // The client's ping() resolves { success: false } instead of throwing, so
  // a probe that only awaits it reports an unreachable server as up.
  it('reports down when ping resolves unsuccessfully', async () => {
    ch.ping.mockResolvedValue({
      success: false,
      error: new Error('ECONNREFUSED'),
    });
    await expect(engine.health()).resolves.toEqual({
      status: 'down',
      adapter: 'clickhouse',
      message: 'ECONNREFUSED',
    });
  });

  it('reports up when ping succeeds', async () => {
    ch.ping.mockResolvedValue({ success: true });
    await expect(engine.health()).resolves.toMatchObject({ status: 'up' });
  });
});

describe('ClickHouseOlapEngine shutdown', () => {
  it('waits for inserts in flight before closing the client', async () => {
    let finish!: () => void;
    const order: string[] = [];
    const client = {
      insert: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = () => {
              order.push('insert');
              resolve();
            };
          }),
      ),
      close: jest.fn(() => {
        order.push('close');
        return Promise.resolve();
      }),
    };
    const engine = new ClickHouseOlapEngine(
      { url: 'http://x', username: 'u', password: 'p', database: 'd' },
      client as never,
    );

    const write = engine.insert('logs.t', [{ a: 1 }]);
    const shutdown = engine.onApplicationShutdown();
    await new Promise((r) => setImmediate(r));
    expect(client.close).not.toHaveBeenCalled();

    finish();
    await Promise.all([write, shutdown]);
    expect(order).toEqual(['insert', 'close']);
  });
});

describe('DisabledOlapAdapter', () => {
  it('rejects calls and reports disabled', async () => {
    const adapter = new DisabledOlapAdapter();
    await expect(adapter.insert()).rejects.toBeInstanceOf(
      CapabilityDisabledError,
    );
    await expect(adapter.health()).resolves.toMatchObject({
      status: 'disabled',
    });
  });
});
