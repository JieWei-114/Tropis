import type { Interceptor } from '@connectrpc/connect';
import { timingSafeEqual } from 'crypto';
import { AppError } from '../../../common/errors';

export const SERVICE_TOKEN_HEADER = 'x-service-token';

/**
 * The internal tier's service identity: every call to a guarded service
 * carries `x-service-token`, compared constant-time against the configured
 * token. It runs before authorization and validation, so a caller without
 * the identity learns nothing about a method's input. An empty token
 * disables the guarded services (NOT_IMPLEMENTED). Only internal-only
 * services are guarded; health, reflection and services also served on the
 * public tier are not, so probes need no token.
 */
export function serviceIdentityInterceptor(
  expectedToken: () => string,
  guarded: ReadonlySet<string>,
): Interceptor {
  return (next) => async (req) => {
    if (!guarded.has(req.service.typeName)) return next(req);
    const expected = expectedToken();
    if (!expected) {
      throw new AppError('NOT_IMPLEMENTED', {
        detail: 'The internal tier is disabled on this server',
      });
    }
    const given = Buffer.from(req.header.get(SERVICE_TOKEN_HEADER) ?? '');
    const want = Buffer.from(expected);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      throw new AppError('FORBIDDEN', {
        detail: 'Invalid or missing x-service-token',
      });
    }
    return next(req);
  };
}
