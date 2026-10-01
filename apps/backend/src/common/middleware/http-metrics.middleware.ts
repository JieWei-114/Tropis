import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import {
  methodLabel,
  redMetrics,
  statusClass,
  type RedMetrics,
} from '../observability/metrics';

/** `route` label for a request no route matched (404s, probes, scanners). */
export const UNMATCHED_ROUTE = 'unmatched';

/**
 * Records tropis_http_server_requests_total and
 * tropis_http_server_duration_seconds for every HTTP request when its
 * response finishes.
 *
 * A middleware rather than an interceptor: guards and pipes run before
 * interceptors, so an interceptor never sees the 401/403/429 answers they
 * produce, nor 404s for unknown paths. The route label is the matched Express
 * route template (`/api/users/:id`), read at finish time when routing is
 * done.
 */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  private readonly metrics: RedMetrics = redMetrics();

  use(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();
    res.once('finish', () => {
      const labels = {
        method: methodLabel(req.method),
        route: routeTemplate(req, res.statusCode),
        status_class: statusClass(res.statusCode),
      };
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      this.metrics.httpRequests.inc(labels);
      this.metrics.httpDuration.observe(labels, seconds);
    });
    next();
  }
}

/**
 * The matched route template. A 404 answered by a wildcard route is Nest's
 * not-found fallback (`/api/{*path}`), reported as `unmatched`.
 */
export function routeTemplate(req: Request, status: number): string {
  const route = (req as { route?: { path?: unknown } }).route;
  if (!route || typeof route.path !== 'string') return UNMATCHED_ROUTE;
  const template = `${req.baseUrl ?? ''}${route.path}` || '/';
  if (status === 404 && template.includes('*')) return UNMATCHED_ROUTE;
  return template;
}
