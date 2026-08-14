export const ANALYTICS_TOPIC = 'persistent://public/default/analytics-events';
export const ANALYTICS_SUBSCRIPTION = 'analytics-processor-sub';
export const analyticsStatsKey = (tenantId: string) =>
  `analytics:stats:${tenantId}`;
export const ANALYTICS_CACHE_TTL_SEC = 30;

import { ERROR_CODES } from '@tropis/shared';

export const ANALYTICS_ERROR_CODES = {
  NOT_FOUND: ERROR_CODES.ANALYTICS_EVENT_NOT_FOUND,
  CLICKHOUSE_ERR: ERROR_CODES.ANALYTICS_CLICKHOUSE_ERROR,
} as const;
