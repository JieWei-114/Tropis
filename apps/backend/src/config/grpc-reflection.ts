/**
 * Gate for gRPC server reflection (grpc.reflection.v1 / v1alpha), which lets
 * grpcurl, grpcui and Postman discover the full service schema without proto
 * files.
 *
 * Reflection reveals the complete API surface, so it is ON for any
 * non-production NODE_ENV and OFF in production unless explicitly opted in
 * with GRPC_REFLECTION=true. The same gate applies to BOTH listeners (public
 * and internal): the internal tier is network-isolated in production anyway
 * (ClusterIP + NetworkPolicy), but keeping it off by default is the
 * zero-trust-consistent choice, and GRPC_REFLECTION=true flips both when
 * debugging inside the cluster. Each listener only reflects the services it
 * serves (infrastructure/rpc/reflection.ts).
 */
export function grpcReflectionEnabled(
  nodeEnv: string,
  reflectionFlag: boolean,
): boolean {
  return nodeEnv !== 'production' || reflectionFlag;
}
