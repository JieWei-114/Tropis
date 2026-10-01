import { ConfigService } from '@nestjs/config';
import { corsOriginFromEnv } from '../../config/cors.constants';
import { grpcReflectionEnabled } from '../../config/grpc-reflection';
import { RpcServer } from '../../infrastructure/rpc/rpc-server.service';
import type { Surface } from './bootstrap';

/**
 * The RPC listeners a role opens. Port-level tier separation: the public port
 * (RPC_PUBLIC_PORT) has no route to any proto/**\/internal/** service; the internal
 * port (RPC_INTERNAL_PORT) is reachable only in-cluster and its handlers
 * still require x-service-token.
 */
export function rpcSurface(tiers: {
  public?: boolean;
  internal?: boolean;
}): Surface {
  return async (app, listening) => {
    const config = app.get(ConfigService);
    const reflection = grpcReflectionEnabled(
      config.getOrThrow<string>('NODE_ENV'),
      config.getOrThrow<boolean>('GRPC_REFLECTION'),
    );
    const server = app.get(RpcServer);
    const rpc = await server.start({
      publicPort: tiers.public
        ? config.getOrThrow<number>('RPC_PUBLIC_PORT')
        : undefined,
      internalPort: tiers.internal
        ? config.getOrThrow<number>('RPC_INTERNAL_PORT')
        : undefined,
      reflection,
      corsOrigins: corsOriginFromEnv(),
    });
    listening.rpcPublicPort = rpc.publicPort;
    listening.rpcInternalPort = rpc.internalPort;
    listening.rpcReflection = reflection;
    return () => server.stop();
  };
}
