import type { ConfigService } from '@nestjs/config';
import { toTenantId } from '../../../common/keyspace';
import type { WorkflowPort } from '../../../infrastructure/workflow/workflow.port';
import {
  ONBOARDING_TIMEOUT_MARGIN_MS,
  ONBOARDING_WORKFLOW,
} from '../constants/onboarding.constants';
import { OnboardingService } from '../services/onboarding.service';
import * as workflows from '../workflows/onboarding.workflow';

const ACME = toTenantId('acme');

describe('OnboardingService', () => {
  let port: {
    isAvailable: jest.Mock;
    start: jest.Mock;
    count: jest.Mock;
    list: jest.Mock;
  };
  let service: OnboardingService;

  beforeEach(() => {
    port = {
      isAvailable: jest.fn().mockReturnValue(true),
      start: jest.fn().mockResolvedValue({ workflowId: 'w' }),
      count: jest.fn().mockResolvedValue(1),
      list: jest.fn().mockResolvedValue([
        {
          workflowId: 'onboarding-u1',
          status: 'RUNNING',
          startTime: Date.UTC(2026, 8, 30, 8, 15),
          closeTime: null,
        },
      ]),
    };
    service = new OnboardingService(
      port as unknown as WorkflowPort,
      {
        getOrThrow: () => 1234,
      } as unknown as ConfigService,
    );
  });

  // Reproduces the leak: any signed-in user listed every tenant's
  // onboarding workflows.
  it("summarises only the tenant's executions", async () => {
    const res = await service.summary(ACME);
    expect(port.list).toHaveBeenCalledWith(ACME, ONBOARDING_WORKFLOW, 200);
    expect(port.count).toHaveBeenCalledWith(
      ACME,
      ONBOARDING_WORKFLOW,
      'running',
    );
    expect(res).toEqual({
      available: true,
      summary: { running: 1, completed: 1 },
      items: [
        {
          workflowId: 'onboarding-u1',
          userId: 'u1',
          status: 'RUNNING',
          startTime: '2026-09-30T08:15:00.000Z',
          closeTime: null,
        },
      ],
    });
  });

  it('reports unavailable with nothing listed while the engine is down', async () => {
    port.isAvailable.mockReturnValue(false);
    await expect(service.summary(ACME)).resolves.toEqual({
      available: false,
      summary: { running: 0, completed: 0 },
      items: [],
    });
    expect(port.list).not.toHaveBeenCalled();
  });

  it('starts the follow-up with a per-user id and the configured delay', () => {
    service.start(ACME, { userId: 'u1', email: 'a@b.test', name: 'Ada' });
    expect(port.start).toHaveBeenCalledWith(
      ACME,
      ONBOARDING_WORKFLOW,
      [
        {
          tenantId: ACME,
          userId: 'u1',
          email: 'a@b.test',
          name: 'Ada',
          delayMs: 1234,
        },
      ],
      {
        workflowId: 'onboarding-u1',
        executionTimeoutMs: 1234 + ONBOARDING_TIMEOUT_MARGIN_MS,
      },
    );
  });

  // Reproduces the kill: the default 10-minute execution timeout ended the
  // workflow during a follow-up delay longer than that.
  it('outlives a follow-up delay longer than the default execution timeout', () => {
    const delayMs = 24 * 60 * 60 * 1000;
    const long = new OnboardingService(
      port as unknown as WorkflowPort,
      { getOrThrow: () => delayMs } as unknown as ConfigService,
    );
    long.start(ACME, { userId: 'u2', email: 'a@b.test', name: 'Ada' });
    const [, , , options] = port.start.mock.calls[0] as [
      unknown,
      unknown,
      unknown,
      { executionTimeoutMs: number },
    ];
    expect(options.executionTimeoutMs).toBeGreaterThan(delayMs + 5 * 60 * 1000);
  });

  it('starts nothing while the engine is unavailable, and never throws', async () => {
    port.isAvailable.mockReturnValue(false);
    service.start(ACME, { userId: 'u1', email: '', name: '' });
    expect(port.start).not.toHaveBeenCalled();

    port.isAvailable.mockReturnValue(true);
    port.start.mockRejectedValue(new Error('down'));
    expect(() =>
      service.start(ACME, { userId: 'u1', email: '', name: '' }),
    ).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });
});

describe('onboarding workflow definitions', () => {
  it('implements the type the service starts', () => {
    expect(
      typeof (workflows as Record<string, unknown>)[ONBOARDING_WORKFLOW],
    ).toBe('function');
  });
});
