/**
 * Shared Redis connection used by the redis adapters of cache, kv, lock,
 * ratelimit, dedup and realtime. Business code never injects it: it
 * depends on those ports instead.
 */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
