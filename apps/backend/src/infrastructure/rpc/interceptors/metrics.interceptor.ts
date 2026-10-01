import { Code, ConnectError, type Interceptor } from '@connectrpc/connect';
import {
  redMetrics,
  type RedMetrics,
} from '../../../common/observability/metrics';
import { connectCodeString } from './correlation.interceptor';

/**
 * Records tropis_rpc_server_requests_total and
 * tropis_rpc_server_duration_seconds for every call, labelled by service,
 * method and Connect code (`ok` on success). Outermost, so it times the
 * whole interceptor chain and sees the final code.
 */
export function metricsInterceptor(
  metrics: RedMetrics = redMetrics(),
): Interceptor {
  return (next) => async (req) => {
    const start = process.hrtime.bigint();
    let code = 'ok';
    try {
      return await next(req);
    } catch (err) {
      code = connectCodeString(
        err instanceof ConnectError ? err.code : Code.Unknown,
      );
      throw err;
    } finally {
      const labels = {
        service: req.method.parent.typeName,
        method: req.method.name,
        code,
      };
      metrics.rpcRequests.inc(labels);
      metrics.rpcDuration.observe(
        labels,
        Number(process.hrtime.bigint() - start) / 1e9,
      );
    }
  };
}
