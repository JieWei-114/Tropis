import type { TenantId } from '../../common/keyspace';
import type { HealthCheckable } from '../capability';

/**
 * OLAP — append-heavy analytical tables and aggregate queries.
 *
 * Tenancy rule: a table that holds tenant data has a `tenant_id` column that
 * leads its sorting key.
 *   - insert() takes a TenantId and stamps it as `tenant_id` on every row
 *     (a row naming another tenant is rejected), after checking once per
 *     table that `tenant_id` leads the table's sorting key.
 *   - query() takes a TenantId, binds it as the `tenant_id` parameter
 *     (callers cannot pass it), and rejects SQL without a
 *     `tenant_id = {tenant_id:String}` predicate outside comments and
 *     string literals.
 *   - insertGlobal() / queryGlobal() are the explicit opt-out for tables
 *     without tenant data and platform-scope rows.
 *
 * Parameters use the `{name:Type}` placeholder syntax and are bound by the
 * adapter, never interpolated into the SQL text.
 */
export const OLAP = Symbol('OLAP');

/** Parameter the port binds on every tenant-scoped query. */
export const OLAP_TENANT_PARAM = 'tenant_id';

export type OlapRow = Record<string, unknown>;
export type OlapParams = Record<string, unknown>;

export interface OlapPort extends HealthCheckable {
  /** Appends one tenant's rows (plain objects, one key per column). */
  insert(
    tenantId: TenantId,
    table: string,
    rows: readonly object[],
  ): Promise<void>;
  /** Appends rows that belong to no tenant. */
  insertGlobal(table: string, rows: readonly object[]): Promise<void>;
  /** Tenant-scoped query; see the tenancy rule above. */
  query<T extends OlapRow = OlapRow>(
    tenantId: TenantId,
    sql: string,
    params?: OlapParams,
  ): Promise<T[]>;
  /** Query over tables that hold no tenant data. */
  queryGlobal<T extends OlapRow = OlapRow>(
    sql: string,
    params?: OlapParams,
  ): Promise<T[]>;
}

/** Adapter-facing contract; tenancy checks live once in OlapClient. */
export interface OlapEngine extends HealthCheckable {
  insert(table: string, rows: readonly object[]): Promise<void>;
  query(sql: string, params: OlapParams): Promise<OlapRow[]>;
  /** Columns of the table's sorting key, in order; empty when it has none. */
  sortingKey(table: string): Promise<string[]>;
}

export const OLAP_ADAPTERS = ['clickhouse', 'disabled'] as const;
export type OlapAdapterName = (typeof OLAP_ADAPTERS)[number];
