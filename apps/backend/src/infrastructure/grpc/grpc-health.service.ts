import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';

interface HealthCheckResponse {
  status: string;
  timestamp: string;
}

/**
 * Implements the HealthService defined in proto/health/v1/health.proto.
 *
 * How gRPC works here:
 *   1. Client calls HealthService.Check() over HTTP/2 (port 50051)
 *   2. NestJS routes it via @GrpcMethod to this method
 *   3. Returns a typed protobuf response
 *
 * Test with grpcurl:
 *   grpcurl -plaintext -proto proto/health/v1/health.proto \
 *     localhost:50051 app.HealthService/Check
 */
@Controller()
export class GrpcHealthService {
  @GrpcMethod('HealthService', 'Check')
  check(): HealthCheckResponse {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }
}
