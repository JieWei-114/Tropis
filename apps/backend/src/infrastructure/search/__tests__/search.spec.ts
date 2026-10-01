import { toTenantId } from '../../../common/keyspace';
import { CapabilityDisabledError } from '../../capability';
import { DisabledSearchAdapter } from '../adapters/disabled/disabled-search.adapter';
import { ElasticsearchSearchEngine } from '../adapters/elasticsearch/elasticsearch-search.engine';
import { SearchClient, searchDocumentId } from '../search.client';
import type { SearchPort } from '../search.port';
import { InMemorySearchEngine } from './in-memory-search.engine';
import { describeSearchPort } from './search.conformance';

describeSearchPort('SearchClient over in-memory engine', {
  make: () => new SearchClient(new InMemorySearchEngine()),
});

describe('SearchClient', () => {
  const T = toTenantId('acme');

  it('stores documents under a tenant-qualified id', async () => {
    const engine = new InMemorySearchEngine();
    await new SearchClient(engine).index(T, 'users', 'u1', { id: 'u1' });
    expect([...engine.indices.get('users')!.keys()]).toEqual([
      searchDocumentId(T, 'u1'),
    ]);
  });

  it('always maps the tenant field as a keyword', async () => {
    const engine = new InMemorySearchEngine();
    const ensure = jest.spyOn(engine, 'ensureIndex');
    await new SearchClient(engine).ensureIndex('users', {
      name: { type: 'text' },
    });
    expect(ensure).toHaveBeenCalledWith('users', {
      name: { type: 'text' },
      tenantId: { type: 'keyword' },
    });
  });

  it('ensures the index with the declared mapping before the first write', async () => {
    const engine = new InMemorySearchEngine();
    const ensure = jest.spyOn(engine, 'ensureIndex');
    const put = jest.spyOn(engine, 'put');
    ensure.mockRejectedValueOnce(new Error('down'));
    const client = new SearchClient(engine);
    await expect(
      client.ensureIndex('users', { name: { type: 'text' } }),
    ).rejects.toThrow('down');

    await client.index(T, 'users', 'u1', { name: 'a' });
    await client.index(T, 'users', 'u2', { name: 'b' });

    expect(ensure).toHaveBeenCalledTimes(2);
    expect(ensure).toHaveBeenLastCalledWith('users', {
      name: { type: 'text' },
      tenantId: { type: 'keyword' },
    });
    expect(ensure.mock.invocationCallOrder[1]).toBeLessThan(
      put.mock.invocationCallOrder[0],
    );
  });

  it('maps the tenant field on a write to an index never declared', async () => {
    const engine = new InMemorySearchEngine();
    const ensure = jest.spyOn(engine, 'ensureIndex');
    await new SearchClient(engine).index(T, 'notes', 'n1', { text: 'x' });
    expect(ensure).toHaveBeenCalledWith('notes', {
      tenantId: { type: 'keyword' },
    });
  });

  it('does not write when the index cannot be ensured', async () => {
    const engine = new InMemorySearchEngine();
    jest.spyOn(engine, 'ensureIndex').mockRejectedValue(new Error('refused'));
    const put = jest.spyOn(engine, 'put');
    await expect(
      new SearchClient(engine).index(T, 'users', 'u1', { name: 'a' }),
    ).rejects.toThrow('refused');
    expect(put).not.toHaveBeenCalled();
  });

  it('rejects a malformed tenant id', async () => {
    await expect(
      new SearchClient(new InMemorySearchEngine()).query(
        'a:b' as never,
        'users',
        'x',
        { fields: ['name'] },
      ),
    ).rejects.toThrow(/Invalid tenant id/);
  });
});

describe('ElasticsearchSearchEngine', () => {
  const es = {
    info: jest.fn(),
    ping: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    indices: {
      exists: jest.fn(),
      create: jest.fn(),
      putMapping: jest.fn(),
      getMapping: jest.fn(),
    },
    index: jest.fn(),
    search: jest.fn(),
    delete: jest.fn(),
  };
  const engine = new ElasticsearchSearchEngine(
    { node: 'http://unused' },
    es as never,
  );

  beforeEach(() => jest.clearAllMocks());

  it('logs success on init when the cluster is reachable', async () => {
    es.info.mockResolvedValue({ cluster_name: 'test' });
    await engine.onModuleInit();
    expect(es.info).toHaveBeenCalled();
  });

  it('warns (does not throw) when the cluster is unreachable on init', async () => {
    es.info.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(engine.onModuleInit()).resolves.toBeUndefined();
  });

  it('creates the index with its mappings when missing', async () => {
    es.indices.exists.mockResolvedValue(false);
    es.indices.create.mockResolvedValue({});
    await engine.ensureIndex('users', { id: { type: 'keyword' } });
    expect(es.indices.create).toHaveBeenCalledWith({
      index: 'users',
      mappings: {
        dynamic_templates: [
          {
            tenant_keyword: {
              match: 'tenantId',
              mapping: { type: 'keyword' },
            },
          },
        ],
        properties: { id: { type: 'keyword' } },
      },
    });
  });

  it('refuses an existing index whose tenant field is not a keyword', async () => {
    es.indices.exists.mockResolvedValue(true);
    es.indices.putMapping.mockRejectedValue(new Error('conflict'));
    es.indices.getMapping.mockResolvedValue({
      users: { mappings: { properties: { tenantId: { type: 'text' } } } },
    });
    await expect(
      engine.ensureIndex('users', { tenantId: { type: 'keyword' } }),
    ).rejects.toThrow(/tenantId as text/);
  });

  it('adds missing fields to an existing index instead of recreating it', async () => {
    es.indices.exists.mockResolvedValue(true);
    es.indices.putMapping.mockResolvedValue({});
    es.indices.getMapping.mockResolvedValue({
      users: { mappings: { properties: { tenantId: { type: 'keyword' } } } },
    });
    await engine.ensureIndex('users', { tenantId: { type: 'keyword' } });
    expect(es.indices.create).not.toHaveBeenCalled();
    expect(es.indices.putMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        index: 'users',
        properties: { tenantId: { type: 'keyword' } },
      }),
    );
  });

  it('filters the query on the tenant field', async () => {
    es.search.mockResolvedValue({
      hits: { hits: [{ _source: { id: '1' } }], total: { value: 1 } },
    });

    const result = await engine.search('users', {
      text: 'ali',
      fields: ['name^2'],
      fuzzy: true,
      from: 0,
      size: 5,
      filter: { field: 'tenantId', value: 'acme' },
    });

    expect(es.search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: {
          bool: {
            must: {
              multi_match: {
                query: 'ali',
                fields: ['name^2'],
                fuzziness: 'AUTO',
              },
            },
            filter: { term: { tenantId: 'acme' } },
          },
        },
      }),
    );
    expect(result).toEqual({ hits: [{ id: '1' }], total: 1 });
  });

  it('treats a delete of a missing document as success', async () => {
    await engine.delete('users', 'acme:1');
    expect(es.delete).toHaveBeenCalledWith(
      { index: 'users', id: 'acme:1' },
      { ignore: [404] },
    );
  });

  it('reports down when ping fails', async () => {
    es.ping.mockRejectedValue(new Error('down'));
    await expect(engine.health()).resolves.toMatchObject({ status: 'down' });
  });
});

describe('DisabledSearchAdapter', () => {
  it('rejects calls and reports disabled', async () => {
    const adapter: SearchPort = new DisabledSearchAdapter();
    await expect(
      adapter.query(toTenantId('acme'), 'users', 'x', { fields: ['n'] }),
    ).rejects.toBeInstanceOf(CapabilityDisabledError);
    await expect(adapter.health()).resolves.toMatchObject({
      status: 'disabled',
    });
  });
});
