import { toTenantId, type TenantId } from '../../../common/keyspace';
import {
  uniqueId,
  type ConformanceTarget,
} from '../../capability/__tests__/conformance-helpers';
import type { GraphNode, GraphPort } from '../graph.port';
import { GraphTenancyError } from '../graph.tenancy';

/** Behaviour every GraphPort adapter must share. */
export function describeGraphPort(
  adapter: string,
  target: ConformanceTarget<GraphPort>,
): void {
  describe(`GraphPort conformance: ${adapter}`, () => {
    let graph: GraphPort;
    const run = uniqueId().slice(0, 8);
    const tenantA: TenantId = toTenantId(`graph-a-${run}`);
    const tenantB: TenantId = toTenantId(`graph-b-${run}`);

    const countPeople = async (tenantId: TenantId, id?: string) => {
      const rows = await graph.read<{ total: number }>(
        tenantId,
        `MATCH (p:Person {tenantId: $tenantId})
         WHERE $id IS NULL OR p.id = $id
         RETURN count(p) AS total`,
        { id: id ?? null },
      );
      return rows[0].total;
    };

    beforeAll(async () => {
      graph = await target.make();
    });

    afterAll(async () => {
      for (const tenantId of [tenantA, tenantB]) {
        await graph
          .write(tenantId, 'MATCH (n {tenantId: $tenantId}) DETACH DELETE n')
          .catch(() => undefined);
      }
      await target.teardown?.(graph);
    });

    it('reports up', async () => {
      expect((await graph.health()).status).toBe('up');
    });

    it('merges nodes idempotently and stamps the tenant', async () => {
      await graph.mergeNode(tenantA, 'Person', 'p1', { name: 'Ada' });
      await graph.mergeNode(tenantA, 'Person', 'p1', { role: 'admin' });
      expect(await countPeople(tenantA, 'p1')).toBe(1);

      const rows = await graph.read<{ p: GraphNode }>(
        tenantA,
        'MATCH (p:Person {tenantId: $tenantId, id: $id}) RETURN p',
        { id: 'p1' },
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].p.labels).toEqual(['Person']);
      expect(rows[0].p.properties).toEqual({
        tenantId: tenantA,
        id: 'p1',
        name: 'Ada',
        role: 'admin',
      });
    });

    it('does not let one tenant read another tenant’s nodes', async () => {
      await graph.mergeNode(tenantA, 'Person', 'only-a');
      expect(await countPeople(tenantB, 'only-a')).toBe(0);
      const rows = await graph.read(
        tenantB,
        'MATCH (p:Person {tenantId: $tenantId}) RETURN p.id AS id',
      );
      expect(rows.map((r) => r.id)).not.toContain('only-a');
    });

    it('refuses a query whose result reaches into another tenant', async () => {
      await graph.mergeNode(tenantA, 'Person', 'leak-a');
      await graph.mergeNode(tenantB, 'Person', 'leak-b');
      await expect(
        graph.read(
          tenantA,
          'MATCH (p:Person) WHERE $tenantId IS NOT NULL RETURN p',
        ),
      ).rejects.toThrow(/outside the tenant/);
    });

    it('keeps equal ids in different tenants as separate nodes', async () => {
      await graph.mergeNode(tenantA, 'Person', 'shared', { name: 'in-a' });
      await graph.mergeNode(tenantB, 'Person', 'shared', { name: 'in-b' });
      const [a] = await graph.read<{ name: string }>(
        tenantA,
        'MATCH (p:Person {tenantId: $tenantId, id: "shared"}) RETURN p.name AS name',
      );
      const [b] = await graph.read<{ name: string }>(
        tenantB,
        'MATCH (p:Person {tenantId: $tenantId, id: "shared"}) RETURN p.name AS name',
      );
      expect(a.name).toBe('in-a');
      expect(b.name).toBe('in-b');
    });

    it('merges edges inside a tenant and refuses edges across tenants', async () => {
      await graph.mergeNode(tenantA, 'Person', 'alice');
      await graph.mergeNode(tenantA, 'Team', 'core');
      await graph.mergeNode(tenantB, 'Team', 'rival');

      expect(
        await graph.mergeEdge(
          tenantA,
          'Person',
          'alice',
          'MEMBER_OF',
          'Team',
          'core',
          {
            since: 2024,
          },
        ),
      ).toBe(true);
      expect(
        await graph.mergeEdge(
          tenantA,
          'Person',
          'alice',
          'MEMBER_OF',
          'Team',
          'core',
        ),
      ).toBe(true);
      expect(
        await graph.mergeEdge(
          tenantA,
          'Person',
          'alice',
          'MEMBER_OF',
          'Team',
          'rival',
        ),
      ).toBe(false);
      expect(
        await graph.mergeEdge(
          tenantB,
          'Person',
          'alice',
          'MEMBER_OF',
          'Team',
          'rival',
        ),
      ).toBe(false);

      const edges = await graph.read<{
        team: string;
        since: number;
        tenant: string;
      }>(
        tenantA,
        `MATCH (:Person {tenantId: $tenantId, id: 'alice'})
               -[r:MEMBER_OF {tenantId: $tenantId}]->(t:Team {tenantId: $tenantId})
         RETURN t.id AS team, r.since AS since, r.tenantId AS tenant`,
      );
      expect(edges).toEqual([{ team: 'core', since: 2024, tenant: tenantA }]);

      const fromB = await graph.read(
        tenantB,
        `MATCH (p:Person {tenantId: $tenantId})-[:MEMBER_OF]->(t)
         RETURN t.id AS team`,
      );
      expect(fromB).toEqual([]);
    });

    it('runs hand-written writes with $tenantId bound', async () => {
      await graph.write(
        tenantA,
        'CREATE (:Tag {tenantId: $tenantId, id: $id, name: $name})',
        { id: `tag-${run}`, name: 'graph' },
      );
      const rows = await graph.read(
        tenantA,
        'MATCH (t:Tag {tenantId: $tenantId}) RETURN t.name AS name',
      );
      expect(rows).toEqual([{ name: 'graph' }]);
    });

    it('rejects queries and inputs that bypass tenancy', async () => {
      await expect(graph.read(tenantA, 'MATCH (n) RETURN n')).rejects.toThrow(
        GraphTenancyError,
      );
      await expect(
        graph.read(tenantA, 'MATCH (n) RETURN n // $tenantId'),
      ).rejects.toThrow(GraphTenancyError);
      await expect(
        graph.read(tenantA, "MATCH (n) WHERE n.x = '$tenantId' RETURN n"),
      ).rejects.toThrow(GraphTenancyError);
      await expect(
        graph.read(tenantA, 'MATCH (n {tenantId: $tenantId}) RETURN n', {
          tenantId: tenantB,
        }),
      ).rejects.toThrow(GraphTenancyError);
      await expect(
        graph.mergeNode(tenantA, 'Person', 'x', { tenantId: tenantB } as never),
      ).rejects.toThrow(GraphTenancyError);
      await expect(
        graph.mergeNode(tenantA, 'Person) DETACH DELETE (x', 'x'),
      ).rejects.toThrow(GraphTenancyError);
      await expect(
        graph.mergeEdge(tenantA, 'Person', 'a', 'bad-type', 'Team', 'b'),
      ).rejects.toThrow(GraphTenancyError);
      expect(await countPeople(tenantA, 'x')).toBe(0);
    });
  });
}
