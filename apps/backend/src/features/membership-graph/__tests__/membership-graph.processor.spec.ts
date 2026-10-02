import type { EventEnvelope } from '@tropis/shared';
import { toTenantId } from '../../../common/keyspace';
import { InMemoryDedupAdapter } from '../../../infrastructure/dedup/__tests__/in-memory-dedup.adapter';
import { consumerHarness } from '../../../infrastructure/messaging/__tests__/consumer-harness';
import { USER_EVENTS } from '../../../modules/user/constants/user.constants';
import { MembershipGraphProcessor } from '../processors/membership-graph.processor';
import type { MembershipGraphService } from '../services/membership-graph.service';

const ACME = toTenantId('acme');

const envelope = (type: string, id: string): EventEnvelope => ({
  specversion: '1.0',
  id,
  type,
  source: '/test',
  time: new Date(0).toISOString(),
  datacontenttype: 'application/json',
  schemaversion: '1',
  tenantid: ACME,
  data: undefined,
});

describe('MembershipGraphProcessor', () => {
  let membership: jest.Mocked<
    Pick<MembershipGraphService, 'isEnabled' | 'recordMember' | 'removeMember'>
  >;
  let broker: { subscribe: jest.Mock };
  let deliver: ReturnType<typeof consumerHarness>['deliver'];
  let processor: MembershipGraphProcessor;

  beforeEach(() => {
    membership = {
      isEnabled: jest.fn().mockResolvedValue(true),
      recordMember: jest.fn().mockResolvedValue(true),
      removeMember: jest.fn().mockResolvedValue(undefined),
    };
    const h = consumerHarness(new InMemoryDedupAdapter());
    broker = { subscribe: h.subscribe };
    deliver = h.deliver;
    processor = new MembershipGraphProcessor(
      membership as unknown as MembershipGraphService,
      h.consumer,
    );
  });

  const handle = async (body: unknown, env: EventEnvelope) => {
    if (!broker.subscribe.mock.calls.length) await processor.onModuleInit();
    return deliver(body, env);
  };

  it('does not subscribe when the graph capability is disabled', async () => {
    membership.isEnabled.mockResolvedValue(false);
    await processor.onModuleInit();
    expect(broker.subscribe).not.toHaveBeenCalled();
  });

  it('subscribes to user events on its own subscription when enabled', async () => {
    await processor.onModuleInit();
    expect(broker.subscribe).toHaveBeenCalledWith(
      expect.stringContaining('user-events'),
      'membership-graph-sub',
      expect.any(Function),
      { type: 'key_shared' },
    );
  });

  it('projects a created user with its inviter', async () => {
    await handle(
      { userId: 'u2', tenantId: 'acme', invitedBy: 'u1' },
      envelope(USER_EVENTS.CREATED, 'e1'),
    );
    expect(membership.recordMember).toHaveBeenCalledWith(ACME, {
      userId: 'u2',
      invitedBy: 'u1',
    });
  });

  it('processes a redelivered event once', async () => {
    const env = envelope(USER_EVENTS.CREATED, 'e2');
    await handle({ userId: 'u3' }, env);
    await handle({ userId: 'u3' }, env);
    expect(membership.recordMember).toHaveBeenCalledTimes(1);
  });

  it('removes membership on identity.user.deleted', async () => {
    await handle({ userId: 'u4' }, envelope(USER_EVENTS.DELETED, 'e3'));
    expect(membership.removeMember).toHaveBeenCalledWith(ACME, 'u4');
  });

  it('accepts the legacy user event names', async () => {
    await handle({ userId: 'u7' }, envelope('user.created', 'e6'));
    await handle({ userId: 'u7' }, envelope('user.deleted', 'e7'));
    expect(membership.recordMember).toHaveBeenCalledWith(ACME, {
      userId: 'u7',
      invitedBy: undefined,
    });
    expect(membership.removeMember).toHaveBeenCalledWith(ACME, 'u7');
  });

  it('ignores types outside the user events contract', async () => {
    await handle({ userId: 'u8' }, envelope('user.account.created', 'e8'));
    expect(membership.recordMember).not.toHaveBeenCalled();
  });

  it('drops a payload that names another tenant', async () => {
    await handle(
      { userId: 'u5', tenantId: 'globex' },
      envelope(USER_EVENTS.CREATED, 'e4'),
    );
    expect(membership.recordMember).not.toHaveBeenCalled();
  });

  it('releases the claim on failure so the redelivery is applied', async () => {
    const env = envelope(USER_EVENTS.UPDATED, 'e5');
    membership.recordMember.mockRejectedValueOnce(new Error('graph down'));
    await expect(handle({ userId: 'u6' }, env)).rejects.toThrow('graph down');
    await handle({ userId: 'u6' }, env);
    expect(membership.recordMember).toHaveBeenCalledTimes(2);
  });
});
