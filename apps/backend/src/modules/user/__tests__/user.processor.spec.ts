import type { ConfigService } from '@nestjs/config';
import type { EventEnvelope } from '@tropis/shared';
import { toTenantId } from '../../../common/keyspace';
import { TenantContext } from '../../../common/tenant/tenant.context';
import type { CachePort } from '../../../infrastructure/cache/cache.port';
import { CapabilityDisabledError } from '../../../infrastructure/capability';
import type { JobsPort } from '../../../infrastructure/jobs/jobs.port';
import type { MailPort } from '../../../infrastructure/mail/mail.port';
import { consumerHarness } from '../../../infrastructure/messaging/__tests__/consumer-harness';
import type { RealtimePort } from '../../../infrastructure/realtime/realtime.port';
import type { SearchPort } from '../../../infrastructure/search/search.port';
import type { WorkflowPort } from '../../../infrastructure/workflow/workflow.port';
import { NotificationService } from '../../notification/services/notification.service';
import {
  USER_EVENTS,
  USER_EVENT_SEEN,
  USER_PROFILE_CACHE,
} from '../constants/user.constants';
import { UserStatus } from '../constants/user.enums';
import { UserProcessor } from '../processors/user.processor';
import type { UserRepository } from '../repositories/user.repository';
import { OnboardingService } from '../services/onboarding.service';
import { UserProjectionService } from '../services/user-projection.service';
import { UserSearchService } from '../services/user-search.service';
import type { UserSimilarityService } from '../services/user-similarity.service';

/**
 * The created-user fan-out is the app's most consequential handler: it owns
 * the search index, the similarity vectors, the welcome email and the
 * onboarding workflow. A throw anywhere in it costs all four, so its contract
 * is pinned through the real consumer, projection and services.
 */
describe('UserProcessor', () => {
  let dedup: {
    claimMany: jest.Mock;
    extendMany: jest.Mock;
    releaseMany: jest.Mock;
  };
  let cache: { del: jest.Mock };
  let search: { index: jest.Mock; remove: jest.Mock };
  let vector: { upsert: jest.Mock; remove: jest.Mock };
  let jobs: { enqueue: jest.Mock };
  let workflows: { isAvailable: jest.Mock; start: jest.Mock };
  let users: { findById: jest.Mock };
  let deliver: ReturnType<typeof consumerHarness>['deliver'];

  const created = (userId = 'user-1', tenantId: string | null = 'acme') => ({
    userId,
    tenantId,
    name: 'Ada',
    email: 'ada@example.com',
    age: 36,
  });

  beforeEach(async () => {
    dedup = {
      claimMany: jest.fn((keys: string[]) =>
        Promise.resolve(keys.map(() => true)),
      ),
      extendMany: jest.fn((keys: string[]) =>
        Promise.resolve(keys.map(() => true)),
      ),
      releaseMany: jest.fn((keys: string[]) =>
        Promise.resolve(keys.map(() => true)),
      ),
    };
    cache = { del: jest.fn().mockResolvedValue(undefined) };
    search = {
      index: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    vector = {
      upsert: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    jobs = { enqueue: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    workflows = {
      isAvailable: jest.fn().mockReturnValue(true),
      start: jest.fn().mockResolvedValue({ workflowId: 'wf' }),
    };
    users = {
      findById: jest.fn((_t: string, id: string) =>
        Promise.resolve({
          _id: id,
          name: 'Ada',
          email: 'ada@example.com',
          age: 36,
          status: UserStatus.ACTIVE,
          loginCount: 0,
        }),
      ),
    };

    const h = consumerHarness(dedup);
    deliver = h.deliver;
    const repo = users as unknown as UserRepository;
    const projection = new UserProjectionService(
      repo,
      new UserSearchService(
        search as unknown as SearchPort,
        vector as unknown as UserSimilarityService,
        repo,
        new TenantContext(),
      ),
      new NotificationService(
        {} as RealtimePort,
        {} as MailPort,
        jobs as unknown as JobsPort,
      ),
      new OnboardingService(
        workflows as unknown as WorkflowPort,
        {
          getOrThrow: () => 30_000,
        } as unknown as ConfigService,
      ),
      cache as unknown as CachePort,
    );
    new UserProcessor(h.consumer, projection).onModuleInit();
  });

  /** One delivery: `data` is the body, the envelope as the adapter builds it. */
  const handle = (
    data: Record<string, unknown>,
    attrs: Partial<EventEnvelope> = {},
  ) => {
    const tenant =
      'tenantid' in attrs
        ? (attrs.tenantid ?? null)
        : typeof data.tenantId === 'string'
          ? data.tenantId
          : null;
    return deliver(
      data,
      {
        id: 'evt-1',
        type: USER_EVENTS.CREATED,
        subject: typeof data.userId === 'string' ? data.userId : undefined,
        ...(tenant ? { tenantid: tenant } : {}),
        ...attrs,
      },
      tenant,
    );
  };

  it('reads the event data from the body and id/type/subject from the envelope', async () => {
    await handle(
      { userId: 'user-7', name: 'Ada', email: 'ada@example.com' },
      {
        id: 'evt-7',
        type: USER_EVENTS.CREATED,
        subject: 'user-7',
        tenantid: 'acme',
      },
    );

    expect(dedup.claimMany).toHaveBeenCalledWith(
      [USER_EVENT_SEEN.global('evt-7')],
      30,
      expect.any(String),
    );
    expect(search.index).toHaveBeenCalledWith(
      expect.anything(),
      'users',
      'user-7',
      expect.objectContaining({ name: 'Ada' }),
    );
  });

  it('indexes, vectorises, emails and starts the onboarding workflow', async () => {
    await handle(created());

    expect(search.index).toHaveBeenCalledTimes(1);
    expect(vector.upsert).toHaveBeenCalledTimes(1);
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    expect(workflows.start).toHaveBeenCalledTimes(1);
    expect(dedup.claimMany).toHaveBeenCalledWith(
      [USER_EVENT_SEEN.global('evt-1')],
      30,
      expect.any(String),
    );
  });

  it('indexes into the tenant the event carries', async () => {
    await handle(created('user-1', 'acme'));

    expect(search.index).toHaveBeenCalledWith(
      toTenantId('acme'),
      'users',
      'user-1',
      expect.objectContaining({ id: 'user-1' }),
    );
    expect(vector.upsert).toHaveBeenCalledWith(
      toTenantId('acme'),
      'user-1',
      expect.any(Object),
    );
  });

  it('has no fallback tenant: an event without one is rejected, not filed elsewhere', async () => {
    await expect(handle(created('user-1', null))).rejects.toMatchObject({
      code: 'TENANT_REQUIRED',
    });
    expect(search.index).not.toHaveBeenCalled();
  });

  it('drops an event whose payload names another tenant than its envelope', async () => {
    await handle(created('user-1', 'globex'), { tenantid: 'acme' });
    expect(search.index).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('purges the tenant-scoped profile cache on update', async () => {
    await handle(created('user-1', 'acme'), { type: USER_EVENTS.UPDATED });

    expect(cache.del).toHaveBeenCalledWith(
      USER_PROFILE_CACHE.forTenant(toTenantId('acme'), 'user-1'),
    );
  });

  it('uses a BullMQ-safe deterministic jobId for the welcome email', async () => {
    await handle(created('user-42'));

    const [queueName, , , opts] = jobs.enqueue.mock.calls[0] as [
      string,
      string,
      unknown,
      { jobId: string },
    ];
    expect(queueName).toBe('notification');
    // BullMQ rejects ':' in a custom id — it is its own key separator. A colon
    // here makes the handler throw ("Custom Id cannot contain :") on every
    // signup, costing the index, the vector, the email AND the workflow.
    expect(opts.jobId).not.toContain(':');
    expect(opts.jobId).toMatch(/^[A-Za-z0-9_-]+$/);
    // Deterministic, so a redelivery cannot send a second welcome email.
    expect(opts.jobId).toBe('welcome-user-42');
  });

  it('releases the dedup claim and rethrows when a sink fails, so the broker retries', async () => {
    search.index.mockRejectedValue(new Error('search down'));

    await expect(handle(created())).rejects.toThrow('search down');
    expect(dedup.releaseMany).toHaveBeenCalled(); // claim released for the retry
    expect(dedup.extendMany).not.toHaveBeenCalled(); // never committed
  });

  it('skips an event whose id was already claimed', async () => {
    dedup.claimMany.mockResolvedValue([false]); // claim lost

    await handle(created());

    expect(search.index).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('does not fail the handler when the workflow engine is unavailable', async () => {
    workflows.isAvailable.mockReturnValue(false);

    await expect(handle(created())).resolves.toBeUndefined();
    expect(workflows.start).not.toHaveBeenCalled();
    expect(dedup.extendMany).toHaveBeenCalled(); // still committed
  });

  it('an update redelivered after the delete purges instead of resurrecting', async () => {
    users.findById.mockResolvedValue(null);

    await handle(created('user-1', 'acme'), { type: USER_EVENTS.UPDATED });

    expect(search.index).not.toHaveBeenCalled();
    expect(vector.upsert).not.toHaveBeenCalled();
    expect(search.remove).toHaveBeenCalledWith(
      toTenantId('acme'),
      'users',
      'user-1',
    );
    expect(vector.remove).toHaveBeenCalled();
  });

  it('a created event for a user already deleted sends no welcome', async () => {
    users.findById.mockResolvedValue(null);
    await handle(created());
    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect(workflows.start).not.toHaveBeenCalled();
    expect(search.remove).toHaveBeenCalled();
  });

  it('projects the current user, not a stale event payload', async () => {
    users.findById.mockResolvedValue({
      _id: 'user-1',
      name: 'Ada Newer',
      email: 'new@example.com',
      age: 37,
      status: UserStatus.INACTIVE,
      loginCount: 3,
    });

    await handle(created('user-1', 'acme'), { type: USER_EVENTS.UPDATED });

    expect(search.index).toHaveBeenCalledWith(
      toTenantId('acme'),
      'users',
      'user-1',
      expect.objectContaining({
        name: 'Ada Newer',
        email: 'new@example.com',
        status: UserStatus.INACTIVE,
      }),
    );
  });

  it('HTML-escapes user data in the welcome email', async () => {
    users.findById.mockResolvedValue({
      _id: 'user-1',
      name: '<img src=x onerror=alert(1)>&"\'',
      email: 'ada@example.com',
      status: UserStatus.ACTIVE,
    });

    await handle(created());

    const [, , data] = jobs.enqueue.mock.calls[0] as [
      string,
      string,
      { payload: { html: string } },
    ];
    expect(data.payload.html).not.toContain('<img');
    expect(data.payload.html).toContain(
      '&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;',
    );
  });

  it('treats a disabled capability sink as nothing to project', async () => {
    search.index.mockRejectedValue(new CapabilityDisabledError('search'));
    await expect(handle(created())).resolves.toBeUndefined();
    expect(dedup.extendMany).toHaveBeenCalled();
  });
});
