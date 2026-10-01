import { errorTypeUri, type ProblemDetails } from '@tropis/shared';
import type { NormalizedError } from './normalize';

export interface ProblemContext {
  /** Request path, without the query string (it can carry secrets). */
  instance: string;
  traceId: string;
}

/** The RFC 9457 body for a normalised error. */
export function toProblemDetails(
  err: NormalizedError,
  ctx: ProblemContext,
): ProblemDetails {
  const problem: ProblemDetails = {
    type: errorTypeUri(err.code),
    title: err.definition.publicMessage,
    status: err.httpStatus,
    instance: ctx.instance,
    code: err.code,
    traceId: ctx.traceId,
    retryable: err.definition.retryable,
  };
  if (err.detail) problem.detail = err.detail;
  if (err.fieldViolations.length) problem.errors = err.fieldViolations;
  if (err.checks) problem.checks = err.checks;
  return problem;
}

export function pathOf(url: string | undefined): string {
  return (url ?? '/').split('?')[0] || '/';
}
