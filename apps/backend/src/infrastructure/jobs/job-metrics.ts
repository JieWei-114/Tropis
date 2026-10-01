import { counter } from '../../common/observability/metrics';

export const JOBS_COMPLETED_METRIC = 'tropis_jobs_completed_total';
export const JOBS_FAILED_METRIC = 'tropis_jobs_failed_total';
export const JOBS_DEAD_LETTERED_METRIC = 'tropis_jobs_dead_lettered_total';

/**
 * Job throughput per queue (queue names are code constants). `failed`
 * counts attempts, so a job retried three times counts three.
 */
export function jobMetrics() {
  return {
    completed: counter(JOBS_COMPLETED_METRIC, 'Job attempts that completed', [
      'queue',
    ] as const),
    failed: counter(JOBS_FAILED_METRIC, 'Job attempts that failed', [
      'queue',
    ] as const),
    deadLettered: counter(
      JOBS_DEAD_LETTERED_METRIC,
      'Jobs moved to the dead-letter queue after their last attempt',
      ['queue'] as const,
    ),
  };
}
