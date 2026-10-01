import { toTenantId } from '../../../common/keyspace';
import { AppError } from '../../../common/errors';
import { capabilityUp } from '../../../infrastructure/capability';
import { GraphClient } from '../../../infrastructure/graph/graph.client';
import type {
  GraphEngine,
  GraphParams,
} from '../../../infrastructure/graph/graph.port';
import { MembershipGraphService } from '../services/membership-graph.service';

class RecordingEngine implements GraphEngine {
  readonly calls: { cypher: string; params: GraphParams }[] = [];
  result: Record<string, unknown>[] = [{ merged: 1 }];
  run(_mode: 'read' | 'write', cypher: string, params: GraphParams) {
    this.calls.push({ cypher, params });
    return Promise.resolve(this.result);
  }
  health() {
    return Promise.resolve(capabilityUp('recording'));
  }
  close() {
    return Promise.resolve();
  }
}

describe('MembershipGraphService', () => {
  const tenant = toTenantId('acme');
  let engine: RecordingEngine;
  let service: MembershipGraphService;

  beforeEach(() => {
    engine = new RecordingEngine();
    service = new MembershipGraphService(new GraphClient(engine));
  });

  it('merges tenant, user, membership and invitation through the tenant-enforcing port', async () => {
    engine.result = [];
    await expect(
      service.recordMember(tenant, { userId: 'u2', invitedBy: 'u1' }),
    ).resolves.toBe(true);
    expect(engine.calls).toHaveLength(6);
    for (const call of engine.calls) {
      expect(call.params.tenantId).toBe('acme');
    }
    expect(engine.calls[3].cypher).toContain('MEMBER_OF');
    expect(engine.calls[5].cypher).toContain('INVITED');
  });

  it('never resurrects a removed member', async () => {
    engine.result = [{ removed: true }];
    await expect(
      service.recordMember(tenant, { userId: 'u2', invitedBy: 'u1' }),
    ).resolves.toBe(false);
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0].cypher).toContain('removed');
  });

  it('ignores a self-invitation', async () => {
    await service.recordMember(tenant, { userId: 'u1', invitedBy: 'u1' });
    expect(engine.calls.some((c) => c.cypher.includes('INVITED'))).toBe(false);
  });

  it('bounds the invitation walk and returns the nearest inviter first', async () => {
    engine.result = [{ chain: ['u2', 'u1'] }];
    await expect(service.invitationChain(tenant, 'u3', 3)).resolves.toEqual([
      'u2',
      'u1',
    ]);
    expect(engine.calls[0].cypher).toContain('[:INVITED*1..3]');
    await expect(service.invitationChain(tenant, 'u3', 0)).rejects.toThrow(
      AppError,
    );
    await expect(service.invitationChain(tenant, 'u3', 11)).rejects.toThrow(
      AppError,
    );
  });

  it('validates the member page', async () => {
    engine.result = [{ userId: 'a' }, { userId: 'b' }];
    await expect(service.membersOf(tenant, { limit: 2 })).resolves.toEqual([
      'a',
      'b',
    ]);
    await expect(service.membersOf(tenant, { limit: 0 })).rejects.toThrow(
      AppError,
    );
  });

  // Reproduces the gap: removing a user the graph had not seen yet matched
  // nothing, so a later user.created recorded the deleted user.
  it('leaves a tombstone when the removal arrives before the user', async () => {
    await service.removeMember(tenant, 'late');
    expect(engine.calls[0].cypher).toMatch(/^\s*MERGE \(u:User/);
    expect(engine.calls[0].cypher).toContain('u.removed = true');
  });
});
