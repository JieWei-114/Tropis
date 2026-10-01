import type {
  Aggregate,
  Document,
  HydratedDocument,
  Model,
  Query,
  QueryOptions,
  Schema,
} from 'mongoose';
import { isTenantId, type TenantId } from '../../common/keyspace';
import { isGlobalScope } from '../../common/tenant/tenant.context';
import type { DocumentsTransaction } from './documents.port';
import { sessionOf } from './transaction';

/** Field every tenant-scoped document carries. */
export const DOCUMENT_TENANT_FIELD = 'tenantId';

export class DocumentTenancyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentTenancyError';
  }
}

type Filter = Record<string, unknown>;

const QUERY_OPERATIONS = [
  'countDocuments',
  'deleteMany',
  'deleteOne',
  'distinct',
  'estimatedDocumentCount',
  'find',
  'findOne',
  'findOneAndDelete',
  'findOneAndReplace',
  'findOneAndUpdate',
  'replaceOne',
  'updateMany',
  'updateOne',
] as const;

function assertTenant(tenantId: unknown): asserts tenantId is TenantId {
  if (!isTenantId(tenantId)) {
    throw new DocumentTenancyError(
      `Invalid tenant id ${JSON.stringify(tenantId)}`,
    );
  }
}

function setsTenant(update: unknown): boolean {
  if (!update || typeof update !== 'object') return false;
  if (Array.isArray(update)) return update.some(setsTenant);
  const u = update as Record<string, unknown>;
  if (DOCUMENT_TENANT_FIELD in u) return true;
  return Object.entries(u).some(
    ([op, value]) =>
      op.startsWith('$') &&
      value !== null &&
      typeof value === 'object' &&
      DOCUMENT_TENANT_FIELD in value,
  );
}

/**
 * Schema plugin that fences a collection by tenant: every query and
 * aggregation must filter on a valid `tenantId`, no update may change it,
 * and every inserted document must carry one. The only way past it is an
 * explicit runGlobal() scope (index maintenance, cross-tenant jobs).
 */
export function tenantScopePlugin(schema: Schema): void {
  schema.pre(QUERY_OPERATIONS as never, function (this: unknown) {
    if (isGlobalScope()) return;
    const query = this as Query<unknown, unknown>;
    assertTenant(query.getFilter()[DOCUMENT_TENANT_FIELD]);
    if (setsTenant(query.getUpdate())) {
      throw new DocumentTenancyError('tenantId cannot be changed by an update');
    }
  });

  schema.pre('aggregate', function (this: Aggregate<unknown>) {
    if (isGlobalScope()) return;
    const first = this.pipeline()[0] as { $match?: Filter } | undefined;
    assertTenant(first?.$match?.[DOCUMENT_TENANT_FIELD]);
  });

  schema.pre('save', function (this: Document) {
    assertTenant(this.get(DOCUMENT_TENANT_FIELD));
  });

  schema.pre('insertMany', function (this: unknown, ...args: unknown[]) {
    const docs = args.find(Array.isArray) as Filter[] | undefined;
    for (const doc of docs ?? []) assertTenant(doc?.[DOCUMENT_TENANT_FIELD]);
  });
}

/**
 * Base class for a module's documents repository. Every method takes the
 * TenantId first and adds it to the filter or the inserted document, so a
 * repository built on it cannot issue a tenantless query; the schema plugin
 * rejects any that bypass it.
 */
export abstract class TenantScopedRepository<T extends { tenantId: string }> {
  protected constructor(protected readonly model: Model<T>) {}

  protected scope(tenantId: TenantId, filter: Filter = {}): Filter {
    assertTenant(tenantId);
    if (
      DOCUMENT_TENANT_FIELD in filter &&
      filter[DOCUMENT_TENANT_FIELD] !== tenantId
    ) {
      throw new DocumentTenancyError('Filter names a different tenant');
    }
    return { ...filter, [DOCUMENT_TENANT_FIELD]: tenantId };
  }

  private static assertUpdate(update: unknown): void {
    if (setsTenant(update)) {
      throw new DocumentTenancyError('tenantId cannot be changed by an update');
    }
  }

  protected find(tenantId: TenantId, filter: Filter = {}) {
    return this.model.find(this.scope(tenantId, filter) as never);
  }

  protected findOne(tenantId: TenantId, filter: Filter = {}) {
    return this.model.findOne(this.scope(tenantId, filter) as never);
  }

  protected countDocuments(tenantId: TenantId, filter: Filter = {}) {
    return this.model.countDocuments(this.scope(tenantId, filter) as never);
  }

  protected findOneAndUpdate(
    tenantId: TenantId,
    filter: Filter,
    update: Record<string, unknown>,
    options: QueryOptions<T> = {},
  ) {
    TenantScopedRepository.assertUpdate(update);
    return this.model.findOneAndUpdate(
      this.scope(tenantId, filter) as never,
      update as never,
      { ...options, returnDocument: 'after', includeResultMetadata: false },
    ) as unknown as Query<HydratedDocument<T> | null, HydratedDocument<T>>;
  }

  protected updateOne(
    tenantId: TenantId,
    filter: Filter,
    update: Record<string, unknown>,
    options: QueryOptions<T> = {},
  ) {
    TenantScopedRepository.assertUpdate(update);
    return this.model.updateOne(
      this.scope(tenantId, filter) as never,
      update as never,
      options as never,
    );
  }

  protected findOneAndDelete(tenantId: TenantId, filter: Filter) {
    return this.model.findOneAndDelete(this.scope(tenantId, filter) as never);
  }

  protected async insert(
    tenantId: TenantId,
    data: Partial<T>,
    tx?: DocumentsTransaction,
  ): Promise<HydratedDocument<T>> {
    const session = sessionOf(tx);
    assertTenant(tenantId);
    const own = (data as Filter)[DOCUMENT_TENANT_FIELD];
    if (own !== undefined && own !== tenantId) {
      throw new DocumentTenancyError('Document names a different tenant');
    }
    const [doc] = await this.model.create(
      [{ ...data, [DOCUMENT_TENANT_FIELD]: tenantId }] as never,
      session ? { session } : {},
    );
    return doc as unknown as HydratedDocument<T>;
  }
}
