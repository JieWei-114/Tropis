import { toTenantId, type TenantId } from '../../../common/keyspace';
import { capabilityUp, CapabilityDisabledError } from '../../capability';
import { DisabledGraphAdapter } from '../adapters/disabled/disabled-graph.adapter';
import { GraphClient } from '../graph.client';
import type { GraphEngine, GraphParams, GraphPort } from '../graph.port';
import { GraphTenancyError } from '../graph.tenancy';

class RecordingEngine implements GraphEngine {
  readonly calls: { mode: string; cypher: string; params: GraphParams }[] = [];
  result: Record<string, unknown>[] = [];

  run(mode: 'read' | 'write', cypher: string, params: GraphParams) {
    this.calls.push({ mode, cypher, params });
    return Promise.resolve(this.result);
  }

  health() {
    return Promise.resolve(capabilityUp('recording'));
  }

  close() {
    return Promise.resolve();
  }
}

describe('GraphClient tenancy', () => {
  const tenant = toTenantId('acme');
  let engine: RecordingEngine;
  let graph: GraphClient;

  beforeEach(() => {
    engine = new RecordingEngine();
    graph = new GraphClient(engine);
  });

  it('binds $tenantId from the argument and uses the requested session mode', async () => {
    await graph.read(tenant, 'MATCH (n {tenantId: $tenantId}) RETURN n', {
      a: 1,
    });
    await graph.write(tenant, 'CREATE (:X {tenantId: $tenantId})');
    expect(engine.calls.map((c) => c.mode)).toEqual(['read', 'write']);
    expect(engine.calls[0].params).toEqual({ a: 1, tenantId: 'acme' });
  });

  it('rejects queries that do not reference $tenantId in code', async () => {
    for (const cypher of [
      'MATCH (n) RETURN n',
      'MATCH (n) RETURN n /* $tenantId */',
      'MATCH (n) RETURN "$tenantId"',
      'MATCH (n) RETURN n.`$tenantId`',
      'MATCH (n {tenantId: $tenantIdentifier}) RETURN n',
    ]) {
      await expect(graph.read(tenant, cypher)).rejects.toThrow(
        GraphTenancyError,
      );
    }
    expect(engine.calls).toHaveLength(0);
  });

  it("refuses a result that carries another tenant's node or relationship", async () => {
    engine.result = [
      {
        n: { labels: ['Person'], properties: { tenantId: 'acme', id: 'a' } },
      },
      {
        n: { labels: ['Person'], properties: { tenantId: 'globex', id: 'b' } },
      },
    ];
    await expect(
      graph.read(tenant, 'MATCH (n) WHERE $tenantId IS NOT NULL RETURN n'),
    ).rejects.toThrow(GraphTenancyError);

    engine.result = [
      { path: [{ type: 'MEMBER_OF', properties: { tenantId: 'globex' } }] },
    ];
    await expect(
      graph.read(tenant, 'MATCH p = ()-[r]->() WHERE $tenantId <> "" RETURN p'),
    ).rejects.toThrow(GraphTenancyError);

    engine.result = [
      { n: { labels: ['Person'], properties: { tenantId: 'acme' } }, c: 3 },
    ];
    await expect(
      graph.read(tenant, 'MATCH (n {tenantId: $tenantId}) RETURN n'),
    ).resolves.toHaveLength(1);
  });

  it('rejects a caller-supplied tenantId param and an invalid tenant', async () => {
    await expect(
      graph.read(tenant, 'RETURN $tenantId', { tenantId: 'other' }),
    ).rejects.toThrow(GraphTenancyError);
    await expect(
      graph.read('a:b' as TenantId, 'RETURN $tenantId'),
    ).rejects.toThrow(GraphTenancyError);
  });

  it('stamps tenantId on merged nodes and edges', async () => {
    await graph.mergeNode(tenant, 'Person', 'p1', { name: 'Ada' });
    expect(engine.calls[0].cypher).toContain('{tenantId: $tenantId, id: $id}');
    expect(engine.calls[0].params).toEqual({
      id: 'p1',
      props: { name: 'Ada' },
      tenantId: 'acme',
    });

    engine.result = [{ merged: 1 }];
    await expect(
      graph.mergeEdge(tenant, 'Person', 'p1', 'KNOWS', 'Person', 'p2'),
    ).resolves.toBe(true);
    const edge = engine.calls[1].cypher;
    expect(edge.match(/tenantId: \$tenantId/g)).toHaveLength(3);

    engine.result = [{ merged: 0 }];
    await expect(
      graph.mergeEdge(tenant, 'Person', 'p1', 'KNOWS', 'Person', 'missing'),
    ).resolves.toBe(false);
  });

  it('validates labels, relationship types, ids and reserved properties', async () => {
    await expect(graph.mergeNode(tenant, 'person', 'p')).rejects.toThrow(
      GraphTenancyError,
    );
    await expect(graph.mergeNode(tenant, 'Person`', 'p')).rejects.toThrow(
      GraphTenancyError,
    );
    await expect(graph.mergeNode(tenant, 'Person', '')).rejects.toThrow(
      GraphTenancyError,
    );
    await expect(
      graph.mergeNode(tenant, 'Person', 'p', { id: 'other' } as never),
    ).rejects.toThrow(GraphTenancyError);
    await expect(
      graph.mergeEdge(tenant, 'Person', 'a', 'knows', 'Person', 'b'),
    ).rejects.toThrow(GraphTenancyError);
    expect(engine.calls).toHaveLength(0);
  });

  it('only accepts a branded TenantId', () => {
    // @ts-expect-error a raw string is not a TenantId
    void graph.read('acme', 'RETURN $tenantId').catch(() => undefined);
  });
});

describe('DisabledGraphAdapter', () => {
  it('throws CapabilityDisabledError from every method', async () => {
    const graph: GraphPort = new DisabledGraphAdapter();
    const tenant = toTenantId('acme');
    for (const call of [
      () => graph.read(tenant, 'RETURN $tenantId'),
      () => graph.write(tenant, 'RETURN $tenantId'),
      () => graph.mergeNode(tenant, 'Person', 'p'),
      () => graph.mergeEdge(tenant, 'A', 'a', 'R', 'B', 'b'),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(CapabilityDisabledError);
    }
    expect((await graph.health()).status).toBe('disabled');
  });
});
