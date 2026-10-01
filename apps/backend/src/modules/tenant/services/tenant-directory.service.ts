import { Inject, Injectable } from '@nestjs/common';
import { toTenantId, type TenantId } from '../../../common/keyspace';
import { parseTenantId } from '../../../common/tenant/tenant.context';
import type {
  RegisterTenantInput,
  TenantDirectory,
  TenantRecord,
} from '../../../common/tenant/tenant-directory.port';
import {
  CACHE,
  type CachePort,
} from '../../../infrastructure/cache/cache.port';
import { TenantRepository } from '../repositories/tenant.repository';
import type { TenantDocument } from '../schemas/tenant.schema';
import {
  TENANT_RECORD_CACHE,
  TENANT_RECORD_CACHE_TTL_SECONDS,
} from '../constants/tenant.constants';

function toRecord(doc: TenantDocument): TenantRecord {
  return {
    id: toTenantId(doc._id),
    name: doc.name,
    status: doc.status,
    selfSignup: doc.selfSignup === true,
  };
}

/**
 * TenantDirectory over the `tenants` documents collection. Lookups are
 * cached for a minute, so suspending a tenant takes effect within that
 * window on every process.
 */
@Injectable()
export class TenantDirectoryService implements TenantDirectory {
  constructor(
    private readonly repo: TenantRepository,
    @Inject(CACHE) private readonly cache: CachePort,
  ) {}

  find(id: TenantId): Promise<TenantRecord | null> {
    const tenantId = parseTenantId(id);
    return this.cache.getOrLoad(
      TENANT_RECORD_CACHE.forTenant(tenantId),
      TENANT_RECORD_CACHE_TTL_SECONDS,
      async () => {
        const doc = await this.repo.findById(tenantId);
        return doc ? toRecord(doc) : null;
      },
    );
  }

  async register(input: RegisterTenantInput): Promise<TenantRecord> {
    const id = parseTenantId(input.id);
    const doc = await this.repo.upsert({
      _id: id,
      name: input.name,
      status: input.status ?? 'active',
      selfSignup: input.selfSignup ?? false,
    });
    await this.cache
      .del(TENANT_RECORD_CACHE.forTenant(id))
      .catch(() => undefined);
    return toRecord(doc);
  }
}
