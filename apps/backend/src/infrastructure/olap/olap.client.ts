import type { OnApplicationShutdown } from '@nestjs/common';
import { isTenantId, type TenantId } from '../../common/keyspace';
import type { CapabilityHealth } from '../capability';
import {
  OLAP_TENANT_PARAM,
  type OlapEngine,
  type OlapParams,
  type OlapPort,
  type OlapRow,
} from './olap.port';

export class OlapTenancyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OlapTenancyError';
  }
}

const TENANT_PREDICATE =
  /(^|[^\w.])(\w+\.)?tenant_id\s*=\s*\{\s*tenant_id\s*:\s*String\s*\}/;

/** Removes comments and string literals so a predicate inside them does not count. */
function stripNonCode(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:\\.|''|[^'\\])*'/g, "''");
}

export function assertTenantScopedSql(sql: string): void {
  if (typeof sql !== 'string' || !TENANT_PREDICATE.test(stripNonCode(sql))) {
    throw new OlapTenancyError(
      'Tenant-scoped OLAP query must filter tenant_id = {tenant_id:String} (outside comments and strings)',
    );
  }
}

function assertTenant(tenantId: TenantId): void {
  if (!isTenantId(tenantId)) {
    throw new OlapTenancyError(`Invalid tenant id ${JSON.stringify(tenantId)}`);
  }
}

/** OlapPort over any OlapEngine; the single place tenancy is enforced. */
export class OlapClient implements OlapPort, OnApplicationShutdown {
  private readonly checkedTables = new Map<string, Promise<void>>();

  constructor(private readonly engine: OlapEngine) {}

  async insert(
    tenantId: TenantId,
    table: string,
    rows: readonly object[],
  ): Promise<void> {
    assertTenant(tenantId);
    if (rows.length === 0) return;
    const stamped = rows.map((row) => {
      const own = (row as Record<string, unknown>)[OLAP_TENANT_PARAM];
      if (own !== undefined && own !== tenantId) {
        throw new OlapTenancyError('Row names a different tenant');
      }
      return { ...row, [OLAP_TENANT_PARAM]: tenantId };
    });
    await this.assertTenantTable(table);
    await this.engine.insert(table, stamped);
  }

  insertGlobal(table: string, rows: readonly object[]): Promise<void> {
    if (rows.length === 0) return Promise.resolve();
    return this.engine.insert(table, rows);
  }

  async query<T extends OlapRow = OlapRow>(
    tenantId: TenantId,
    sql: string,
    params: OlapParams = {},
  ): Promise<T[]> {
    assertTenant(tenantId);
    assertTenantScopedSql(sql);
    if (Object.prototype.hasOwnProperty.call(params, OLAP_TENANT_PARAM)) {
      throw new OlapTenancyError(
        `'${OLAP_TENANT_PARAM}' is bound by the OLAP port; do not pass it in params`,
      );
    }
    return (await this.engine.query(sql, {
      ...params,
      [OLAP_TENANT_PARAM]: tenantId,
    })) as T[];
  }

  async queryGlobal<T extends OlapRow = OlapRow>(
    sql: string,
    params: OlapParams = {},
  ): Promise<T[]> {
    return (await this.engine.query(sql, params)) as T[];
  }

  health(): Promise<CapabilityHealth> {
    return this.engine.health();
  }

  async onApplicationShutdown(): Promise<void> {
    await (
      this.engine as Partial<OnApplicationShutdown>
    ).onApplicationShutdown?.();
  }

  /** Checked once per table; a failed check is retried on the next insert. */
  private assertTenantTable(table: string): Promise<void> {
    let check = this.checkedTables.get(table);
    if (!check) {
      check = this.engine.sortingKey(table).then((key) => {
        if (key[0] !== OLAP_TENANT_PARAM) {
          throw new OlapTenancyError(
            `Table ${table} holds tenant rows, so its sorting key must lead with tenant_id (got ${key.join(', ') || 'none'})`,
          );
        }
      });
      check.catch(() => this.checkedTables.delete(table));
      this.checkedTables.set(table, check);
    }
    return check;
  }
}
