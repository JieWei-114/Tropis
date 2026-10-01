import { defineKey } from '../../../common/keyspace';

/** Cached directory record of one tenant (null when unregistered): forTenant(tenantId). */
export const TENANT_RECORD_CACHE = defineKey({
  capability: 'cache',
  module: 'tenant',
  name: 'record',
  version: 'v1',
});

export const TENANT_RECORD_CACHE_TTL_SECONDS = 60;
