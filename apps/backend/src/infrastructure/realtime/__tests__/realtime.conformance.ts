import { toTenantId } from '../../../common/keyspace';
import {
  sleep,
  uniqueId,
} from '../../capability/__tests__/conformance-helpers';
import type { RealtimePort } from '../realtime.port';
import { recorder, type GatewayNode } from './realtime-harness';

export interface RealtimeCluster {
  /** Publisher in a process that holds no sockets (e.g. a worker). */
  publisher: RealtimePort;
  /** Gateway processes holding client sockets. */
  nodes: GatewayNode[];
  /** Resolves once every node is listening for publishes. */
  ready?(): Promise<void>;
  teardown(): Promise<void>;
}

async function eventually(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(20);
  }
}

/** Behaviour every RealtimePort adapter must share. */
export function describeRealtimePort(
  adapter: string,
  make: () => Promise<RealtimeCluster>,
): void {
  describe(`RealtimePort conformance: ${adapter}`, () => {
    let cluster: RealtimeCluster;
    const run = uniqueId().slice(0, 8);
    const tenantA = toTenantId(`rt-a-${run}`);
    const tenantB = toTenantId(`rt-b-${run}`);

    beforeAll(async () => {
      cluster = await make();
      await cluster.ready?.();
    });

    afterAll(async () => {
      await cluster?.teardown();
    });

    it('reports up', async () => {
      expect((await cluster.publisher.health()).status).toBe('up');
    });

    it('delivers a tenant publish to that tenant on every node and never to another tenant', async () => {
      const last = cluster.nodes.length - 1;
      const a1 = recorder(await cluster.nodes[0].connect(tenantA, 'u1'));
      const a2 = recorder(await cluster.nodes[last].connect(tenantA, 'u2'));
      const b1 = recorder(await cluster.nodes[0].connect(tenantB, 'u1'));
      const b2 = recorder(await cluster.nodes[last].connect(tenantB, 'u2'));

      await cluster.publisher.publishToTenant(tenantA, 'tenant.news', {
        n: 1,
      });

      await eventually(() => a1.length > 0 && a2.length > 0);
      await sleep(300);
      expect(a1).toEqual([{ event: 'tenant.news', data: { n: 1 } }]);
      expect(a2).toEqual([{ event: 'tenant.news', data: { n: 1 } }]);
      expect(b1).toEqual([]);
      expect(b2).toEqual([]);
    });

    it('delivers a user publish only to that user of that tenant', async () => {
      const last = cluster.nodes.length - 1;
      const target = recorder(await cluster.nodes[last].connect(tenantA, 'me'));
      const sameTenant = recorder(
        await cluster.nodes[0].connect(tenantA, 'other'),
      );
      const sameIdOtherTenant = recorder(
        await cluster.nodes[0].connect(tenantB, 'me'),
      );

      await cluster.publisher.publishToUser(tenantA, 'me', 'notification', {
        hi: true,
      });

      await eventually(() => target.length > 0);
      await sleep(300);
      expect(target).toEqual([{ event: 'notification', data: { hi: true } }]);
      expect(sameTenant).toEqual([]);
      expect(sameIdOtherTenant).toEqual([]);
    });

    it('delivers a role publish once to each holder of a role, in that tenant only', async () => {
      const last = cluster.nodes.length - 1;
      const admin = recorder(
        await cluster.nodes[last].connect(tenantA, 'boss', ['admin', 'editor']),
      );
      const member = recorder(
        await cluster.nodes[0].connect(tenantA, 'joe', ['member']),
      );
      const otherAdmin = recorder(
        await cluster.nodes[0].connect(tenantB, 'boss', ['admin']),
      );

      await cluster.publisher.publishToRoles(
        tenantA,
        ['admin', 'editor'],
        'user.created',
        { userId: 'u9' },
      );

      await eventually(() => admin.length > 0);
      await sleep(300);
      expect(admin).toEqual([
        { event: 'user.created', data: { userId: 'u9' } },
      ]);
      expect(member).toEqual([]);
      expect(otherAdmin).toEqual([]);
    });
  });
}
