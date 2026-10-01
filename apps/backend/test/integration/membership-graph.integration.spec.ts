import { toTenantId } from '../../src/common/keyspace';
import { Neo4jGraphEngine } from '../../src/infrastructure/graph/adapters/neo4j/neo4j-graph.engine';
import { GraphClient } from '../../src/infrastructure/graph/graph.client';
import { MembershipGraphService } from '../../src/features/membership-graph/services/membership-graph.service';
import { describeWithDocker } from './docker';
import {
  readyOrStop,
  startContainer,
  waitUntil,
  type StartedContainer,
} from './containers';

jest.setTimeout(240_000);

const PASSWORD = 'tropis_dev_password';

describeWithDocker('Membership graph (neo4j)')(
  'Membership graph projection (neo4j)',
  () => {
    let container: StartedContainer;
    let graph: GraphClient;
    let membership: MembershipGraphService;
    const acme = toTenantId('mg-acme');
    const globex = toTenantId('mg-globex');

    beforeAll(async () => {
      container = startContainer({
        image: 'neo4j:5-community',
        label: 'neo4j',
        ports: [7687],
        env: { NEO4J_AUTH: `neo4j/${PASSWORD}` },
      });
      graph = new GraphClient(
        new Neo4jGraphEngine({
          uri: `bolt://${container.host}:${container.port(7687)}`,
          user: 'neo4j',
          password: PASSWORD,
        }),
      );
      await readyOrStop(container, () =>
        waitUntil(
          'neo4j',
          async () => (await graph.health()).status === 'up',
          180_000,
          container,
        ),
      );
      membership = new MembershipGraphService(graph);
    });

    afterAll(async () => {
      await graph?.onApplicationShutdown();
      await container?.stop();
    });

    it('projects membership idempotently', async () => {
      await membership.recordMember(acme, { userId: 'root' });
      await membership.recordMember(acme, { userId: 'root' });
      await membership.recordMember(acme, { userId: 'b', invitedBy: 'root' });
      expect(await membership.membersOf(acme)).toEqual(['b', 'root']);
      expect(await membership.membersOf(acme, { limit: 1, offset: 1 })).toEqual(
        ['root'],
      );
    });

    it('walks the invitation chain nearest first, bounded by hops', async () => {
      await membership.recordMember(acme, { userId: 'c', invitedBy: 'b' });
      await membership.recordMember(acme, { userId: 'd', invitedBy: 'c' });
      expect(await membership.invitationChain(acme, 'd')).toEqual([
        'c',
        'b',
        'root',
      ]);
      expect(await membership.invitationChain(acme, 'd', 2)).toEqual([
        'c',
        'b',
      ]);
      expect(await membership.invitationChain(acme, 'root')).toEqual([]);
    });

    it('keeps tenants apart', async () => {
      await membership.recordMember(globex, { userId: 'd', invitedBy: 'x' });
      expect(await membership.membersOf(globex)).toEqual(['d']);
      expect(await membership.invitationChain(globex, 'd')).toEqual(['x']);
      expect(await membership.membersOf(acme)).not.toContain('x');
    });

    it('removes membership but keeps the chain through a removed user', async () => {
      await membership.removeMember(acme, 'c');
      await membership.removeMember(acme, 'c');
      expect(await membership.membersOf(acme)).toEqual(['b', 'd', 'root']);
      expect(await membership.invitationChain(acme, 'd')).toEqual([
        'c',
        'b',
        'root',
      ]);
    });

    it('a late event after the removal does not restore membership', async () => {
      await expect(
        membership.recordMember(acme, { userId: 'c', invitedBy: 'b' }),
      ).resolves.toBe(false);
      expect(await membership.membersOf(acme)).toEqual(['b', 'd', 'root']);
    });

    it('a removal that arrives before the user keeps it out', async () => {
      await membership.removeMember(acme, 'early');
      await expect(
        membership.recordMember(acme, { userId: 'early' }),
      ).resolves.toBe(false);
      expect(await membership.membersOf(acme)).not.toContain('early');
    });
  },
);
