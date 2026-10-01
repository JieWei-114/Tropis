import { Code } from '@connectrpc/connect';
import { TrackingRpcController } from '../controllers/tracking.rpc.controller';
import { TrackingService } from '../services/tracking.service';
import { RpcAuthzService } from '../../../infrastructure/rpc/rpc-authz.service';
import {
  bearer,
  rpcTestContext,
  withAuthorization,
  type RpcCalls,
} from '../../../infrastructure/rpc/testing/rpc-test-context';
import { AuthorizationService } from '../../../common/authz/authorization.service';
import type { PolicyPort } from '../../../infrastructure/policy/policy.port';
import {
  signAccessToken,
  testTokenVerifier,
} from '../../../modules/auth/__tests__/token-fixtures';

describe('TrackingRpcController', () => {
  let controller: RpcCalls<TrackingRpcController>;
  let authz: RpcAuthzService;
  let trackingService: { getInsights: jest.Mock };
  let opa: { allow: jest.Mock };

  beforeEach(() => {
    trackingService = {
      getInsights: jest.fn().mockResolvedValue({
        topPages: [{ page: '/', count: 3 }],
        eventsByName: [{ eventName: 'page.view', count: 3 }],
        dailyUniques: [{ day: '2026-01-01', uniques: 2 }],
        recent: [
          {
            eventId: 'e1',
            eventName: 'page.view',
            anonymousId: 'a1',
            userId: '',
            sessionId: 's1',
            page: '/',
            props: '{}',
            timestamp: 1700000000000,
          },
        ],
        funnel: [{ step: 'page.view', users: 2 }],
      }),
    };
    opa = { allow: jest.fn().mockResolvedValue(true) };
    const authorization = new AuthorizationService(
      opa as unknown as PolicyPort,
    );
    authz = new RpcAuthzService(testTokenVerifier().verifier, authorization);
    controller = withAuthorization(
      new TrackingRpcController(
        trackingService as unknown as TrackingService,
        authz,
      ),
      authorization,
    );
  });

  it('requires a token and analytics:read', async () => {
    await expect(
      controller.getInsights({ days: 7 } as never, await rpcTestContext(authz)),
    ).rejects.toMatchObject({ code: Code.Unauthenticated });

    opa.allow.mockResolvedValue(false);
    const token = signAccessToken({ sub: 'u1' });
    await expect(
      controller.getInsights(
        { days: 7 } as never,
        await rpcTestContext(authz, bearer(token)),
      ),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect(opa.allow).toHaveBeenCalledWith(
      expect.objectContaining({ resource: 'analytics', action: 'read' }),
    );
    expect(trackingService.getInsights).not.toHaveBeenCalled();
  });

  it('scopes to the token tenant and maps to the contract shape', async () => {
    const token = signAccessToken({ sub: 'u1', tenantId: 'acme' });
    const res = await controller.getInsights(
      { days: 0 } as never,
      await rpcTestContext(authz, bearer(token)),
    );

    expect(trackingService.getInsights).toHaveBeenCalledWith('acme', undefined);
    expect(res.eventsByName).toEqual([{ eventName: 'page.view', count: 3 }]);
    expect(res.recent?.[0]).toMatchObject({
      eventId: 'e1',
      anonymousId: 'a1',
      timestamp: 1700000000000n,
    });
    expect(res.funnel).toEqual([{ step: 'page.view', users: 2 }]);
  });
});
