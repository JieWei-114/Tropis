import type { MessageInitShape } from '@bufbuild/protobuf';
import type { ServiceImpl } from '@connectrpc/connect';
import { RpcService } from '../../../infrastructure/rpc/rpc-service.decorator';
import {
  HealthService,
  type HealthCheckResponseSchema,
} from '../../../gen/health/v1/health_pb';

/**
 * Implements tropis.health.v1.HealthService (proto/health/v1/health.proto) on
 * both listeners, so a probe against either port proves that listener is up.
 * It reports liveness of the RPC server only; dependency health is
 * GET /api/health. The standard grpc.health.v1.Health is served next to it by
 * the RpcServer.
 *
 * Try it:
 *   grpcurl -plaintext localhost:50051 tropis.health.v1.HealthService/Check
 */
@RpcService(HealthService, { tiers: ['public', 'internal'] })
export class HealthRpcController implements ServiceImpl<typeof HealthService> {
  check(): MessageInitShape<typeof HealthCheckResponseSchema> {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
