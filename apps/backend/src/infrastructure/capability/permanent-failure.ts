import { AppError } from '../../common/errors/app-error';

/**
 * A failure that retrying cannot fix: an AppError in the 4xx class other
 * than a timeout or a rate limit (the input itself is wrong). Job and
 * workflow adapters stop retrying it and dead-letter or fail at once.
 */
export function isPermanentFailure(err: unknown): boolean {
  if (!(err instanceof AppError)) return false;
  const status = err.httpStatus;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}
