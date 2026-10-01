import type { TenantId } from '../../common/keyspace';
import type { HealthCheckable } from '../capability';

/**
 * Relational — SQL over the relational database. Driver-neutral: parameters
 * are positional (`$1`, `$2`, ...) and rows come back as plain objects.
 *
 * Tenancy is enforced by the database: a table holding tenant rows has a
 * `tenant_id` column and row-level security (enableTenantIsolation), whose
 * policy admits only rows where `tenant_id = current_setting('app.tenant_id')`.
 * withTenant() runs its statements in one transaction that sets
 * `app.tenant_id` (SET LOCAL semantics) and switches to the non-owner role
 * RELATIONAL_TENANT_ROLE, so the policy applies even when the connection user
 * owns the table or is a superuser. query() outside withTenant() carries no
 * tenant, so it sees no row of such a table unless the connection user is a
 * superuser or has BYPASSRLS, which a deployment must not use.
 *
 * Business modules do not use this port directly; capabilities built on it
 * (vector) do.
 */
export const RELATIONAL = Symbol('RELATIONAL');

/** Role every tenant-scoped transaction runs as. */
export const RELATIONAL_TENANT_ROLE = 'tropis_tenant_scope';
/** Transaction-local setting the row-level security policies read. */
export const RELATIONAL_TENANT_SETTING = 'app.tenant_id';

export type RelationalRow = Record<string, unknown>;

export interface RelationalQueryable {
  query<T extends RelationalRow = RelationalRow>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
}

export interface RelationalPort extends RelationalQueryable, HealthCheckable {
  /** Runs `fn` in one transaction scoped to `tenantId` (see above). */
  withTenant<T>(
    tenantId: TenantId,
    fn: (tx: RelationalQueryable) => Promise<T>,
  ): Promise<T>;
  /**
   * Idempotently puts `table` (which has a `tenant_id` column) under
   * row-level security: creates RELATIONAL_TENANT_ROLE when missing, grants
   * it the table, forces RLS and adds the `tenant_isolation` policy.
   */
  enableTenantIsolation(table: string): Promise<void>;
}
