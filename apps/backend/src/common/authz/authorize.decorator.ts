import { SetMetadata } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

export const AUTHORIZE_KEY = 'tropis:authorize';

/** An action on a resource, as the policy engine decides it. */
export interface Permission {
  /** Chosen by the module that owns the resource, e.g. `user`, `analytics`. */
  resource: string;
  action: string;
}

/**
 * Requires the caller's roles to allow `action` on `resource` before the
 * handler runs: the HTTP AuthorizeGuard and the RPC authorization
 * interceptor both read it, so one decorator guards both transports. A
 * handler without it is checked only for authentication.
 */
export const Authorize = (
  resource: string,
  action: string,
): MethodDecorator & ClassDecorator =>
  SetMetadata(AUTHORIZE_KEY, { resource, action } satisfies Permission);

/** The permission on a handler, falling back to its class. */
export function permissionOf(
  reflector: Reflector,
  handler: object,
  owner: object,
): Permission | undefined {
  return reflector.getAllAndOverride<Permission | undefined>(AUTHORIZE_KEY, [
    handler as () => void,
    owner as () => void,
  ]);
}
