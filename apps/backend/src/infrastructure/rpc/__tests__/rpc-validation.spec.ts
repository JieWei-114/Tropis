import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { ServiceImpl } from '@connectrpc/connect';
import { AuditLogService } from '../../../common/audit/audit-log.service';
import { AuthorizationService } from '../../../common/authz/authorization.service';
import { TOKEN_VERIFIER } from '../../../common/auth/token-verifier.port';
import { POLICY } from '../../policy/policy.port';
import { RpcAuthzService } from '../rpc-authz.service';
import { RpcServer } from '../rpc-server.service';
import { RpcService } from '../rpc-service.decorator';
import { TrackingService } from '../../../gen/tracking/v1/tracking_pb';

@RpcService(TrackingService)
class UncheckedTracking implements ServiceImpl<typeof TrackingService> {
  getInsights() {
    return {};
  }
}

describe('RpcServer validation coverage', () => {
  // Every RPC must declare its input rules: a handler that takes fields
  // without @RpcValidate would accept anything a caller sends.
  it('refuses to start when a handler with request fields declares no @RpcValidate', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule],
      providers: [
        RpcServer,
        RpcAuthzService,
        AuthorizationService,
        UncheckedTracking,
        { provide: AuditLogService, useValue: { record: jest.fn() } },
        { provide: POLICY, useValue: { allow: jest.fn() } },
        { provide: TOKEN_VERIFIER, useValue: { verify: jest.fn() } },
      ],
    }).compile();
    const server = moduleRef.get(RpcServer);
    await expect(
      server.start({ reflection: false, corsOrigins: [] }),
    ).rejects.toThrow(/UncheckedTracking\.getInsights.*@RpcValidate/);
    await moduleRef.close();
  });
});
