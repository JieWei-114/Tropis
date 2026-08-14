import type { Server } from '@grpc/grpc-js';
import { ReflectionService } from '@grpc/reflection';

/**
 * gRPC server reflection (dev tooling) — lets grpcurl / grpcui / Postman
 * discover the full service schema without `-proto` flags.
 *
 * Gating: reflection reveals the complete API surface, so it is ON for any
 * non-production NODE_ENV and OFF in production unless explicitly opted in
 * with GRPC_REFLECTION=true. The same gate is applied to BOTH listeners
 * (public :50051 and internal :50061): the internal tier is network-isolated
 * in production anyway (ClusterIP + NetworkPolicy), but keeping it off by
 * default is the zero-trust-consistent choice — GRPC_REFLECTION=true flips
 * both when debugging inside the cluster.
 */
export function grpcReflectionEnabled(
  nodeEnv: string,
  reflectionFlag: boolean,
): boolean {
  return nodeEnv !== 'production' || reflectionFlag;
}

/**
 * `onLoadPackageDefinition` hook for NestJS gRPC microservice options —
 * registers the reflection service on the listener's grpc-js Server.
 * (Documented @grpc/reflection + NestJS pattern.)
 */
export function addGrpcReflection(
  pkg: ConstructorParameters<typeof ReflectionService>[0],
  server: Server,
): void {
  new ReflectionService(pkg).addToServer(server);
}
