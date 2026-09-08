export const ANALYTICS_TOPIC = 'persistent://public/default/analytics-events';
export const ANALYTICS_SUBSCRIPTION = 'analytics-processor-sub';
export const analyticsStatsKey = (tenantId: string) =>
  `analytics:stats:${tenantId}`;
export const ANALYTICS_CACHE_TTL_SEC = 30;
