import type { Interceptor } from '@connectrpc/connect';
import { createLogger } from '../../../common/observability/logger';
import { mapRpcError } from '../rpc-errors';

const logger = createLogger('rpc');

/**
 * Maps whatever a handler (or an inner interceptor) throws to a ConnectError
 * built from the error catalog (rpc-errors.ts), so domain errors keep their
 * meaning on the wire. An error no thrower anticipated reaches the caller as
 * INTERNAL with the generic message; the original is logged here with the
 * trace id.
 */
export const errorsInterceptor: Interceptor = (next) => async (req) => {
  try {
    return await next(req);
  } catch (err) {
    const mapped = mapRpcError(err);
    if (mapped.unexpected) {
      logger.error(
        'unhandled-error',
        'Unhandled error answered as INTERNAL',
        err,
        {
          'rpc.service': req.method.parent.typeName,
          'rpc.method': req.method.name,
        },
      );
    }
    throw mapped.error;
  }
};
