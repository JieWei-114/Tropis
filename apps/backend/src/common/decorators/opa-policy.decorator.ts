import { SetMetadata } from '@nestjs/common';

export interface OpaPolicy {
  resource: string;
  action: string;
}

export const OPA_POLICY_KEY = 'opaPolicy';

/** Attach an OPA policy check to a route/gRPC method. */
export const OpaPolicy = (resource: string, action: string) =>
  SetMetadata(OPA_POLICY_KEY, { resource, action } satisfies OpaPolicy);
