import type { DataSource } from 'typeorm';
import { isTenantId, type TenantId } from '../../../../common/keyspace';
import { probeCapability, type CapabilityHealth } from '../../../capability';
import {
  RELATIONAL_TENANT_ROLE,
  RELATIONAL_TENANT_SETTING,
  type RelationalPort,
  type RelationalQueryable,
  type RelationalRow,
} from '../../relational.port';

const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

export class RelationalTenancyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelationalTenancyError';
  }
}

/** The DDL that puts one table under tenant row-level security. */
export function tenantIsolationStatements(table: string): string[] {
  if (!TABLE_NAME.test(table)) {
    throw new RelationalTenancyError(
      `Invalid table name ${JSON.stringify(table)}`,
    );
  }
  const role = RELATIONAL_TENANT_ROLE;
  const predicate = `tenant_id = current_setting('${RELATIONAL_TENANT_SETTING}', true)`;
  return [
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
         CREATE ROLE ${role} NOLOGIN;
       END IF;
     END $$`,
    `DO $$ BEGIN
       IF NOT pg_has_role(current_user, '${role}', 'MEMBER') THEN
         EXECUTE 'GRANT ${role} TO ' || quote_ident(current_user);
       END IF;
     END $$`,
    `GRANT USAGE ON SCHEMA public TO ${role}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${role}`,
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = '${table}' AND policyname = 'tenant_isolation'
       ) THEN
         CREATE POLICY tenant_isolation ON ${table}
           USING (${predicate}) WITH CHECK (${predicate});
       END IF;
     END $$`,
  ];
}

export class TypeOrmRelationalAdapter implements RelationalPort {
  constructor(private readonly dataSource: DataSource) {}

  query<T extends RelationalRow = RelationalRow>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    return this.dataSource.query(sql, params);
  }

  async withTenant<T>(
    tenantId: TenantId,
    fn: (tx: RelationalQueryable) => Promise<T>,
  ): Promise<T> {
    if (!isTenantId(tenantId)) {
      throw new RelationalTenancyError(
        `Invalid tenant id ${JSON.stringify(tenantId)}`,
      );
    }
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.startTransaction();
      await runner.query(`SELECT set_config($1, $2, true)`, [
        RELATIONAL_TENANT_SETTING,
        tenantId,
      ]);
      await runner.query(`SET LOCAL ROLE ${RELATIONAL_TENANT_ROLE}`);
      const result = await fn({
        query: <R extends RelationalRow = RelationalRow>(
          sql: string,
          params?: unknown[],
        ) => runner.query(sql, params) as Promise<R[]>,
      });
      await runner.commitTransaction();
      return result;
    } catch (err) {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction().catch(() => undefined);
      }
      throw err;
    } finally {
      await runner.release();
    }
  }

  async enableTenantIsolation(table: string): Promise<void> {
    for (const sql of tenantIsolationStatements(table)) {
      await this.dataSource.query(sql);
    }
  }

  health(): Promise<CapabilityHealth> {
    return probeCapability('postgres', () => this.dataSource.query('SELECT 1'));
  }
}
