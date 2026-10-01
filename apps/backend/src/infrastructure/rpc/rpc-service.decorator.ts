import { Injectable, SetMetadata, applyDecorators } from '@nestjs/common';
import type { DescService } from '@bufbuild/protobuf';

/**
 * Which listener serves a service. The tier is a property of the port, not of
 * per-call filtering: the public listener never has an internal route to hit.
 */
export type RpcTier = 'public' | 'internal';

export const RPC_TIERS: readonly RpcTier[] = ['public', 'internal'];

export const RPC_SERVICE_KEY = 'rpc:service';

export interface RpcServiceMetadata {
  service: DescService;
  tiers: readonly RpcTier[];
}

/**
 * Contracts under `proto/<domain>/internal/**` belong to the internal tier;
 * every other contract is public.
 */
export function tierOf(service: DescService): RpcTier {
  return /(^|\/)internal\//.test(service.file.name) ? 'internal' : 'public';
}

/**
 * Marks a Nest provider as the implementation of a generated service. The
 * RpcServer discovers every provider carrying this and routes the service's
 * methods to it, so the implementing class should declare
 * `implements ServiceImpl<typeof Service>` to have tsc hold it to the
 * contract.
 *
 * `tiers` overrides the listener(s) derived from the proto path; only
 * infrastructure services such as health belong on both.
 */
export function RpcService(
  service: DescService,
  options: { tiers?: readonly RpcTier[] } = {},
): ClassDecorator {
  const metadata: RpcServiceMetadata = {
    service,
    tiers: options.tiers ?? [tierOf(service)],
  };
  return applyDecorators(Injectable(), SetMetadata(RPC_SERVICE_KEY, metadata));
}
