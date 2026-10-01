import type { TenantId } from '../../../common/keyspace';
import {
  TENANT_A,
  TENANT_B,
  uniqueId,
  type ConformanceTarget,
} from '../../capability/__tests__/conformance-helpers';
import type { RelationalPort } from '../relational.port';

export interface RelationalConformanceOptions {
  /**
   * False when the connection user bypasses row-level security (a
   * superuser); a query outside withTenant() then sees every row.
   */
  fencedOutsideTenant: boolean;
}

/** Behaviour every RelationalPort adapter must share. */
export function describeRelationalPort(
  adapter: string,
  target: ConformanceTarget<RelationalPort>,
  options: RelationalConformanceOptions,
): void {
  describe(`RelationalPort conformance: ${adapter}`, () => {
    let db: RelationalPort;
    const table = `conformance_${uniqueId().replace(/-/g, '').slice(0, 12)}`;

    const bodies = async (tenantId: TenantId): Promise<string[]> =>
      (
        await db.withTenant(tenantId, (tx) =>
          tx.query<{ body: string }>(`SELECT body FROM ${table} ORDER BY body`),
        )
      ).map((r) => r.body);

    beforeAll(async () => {
      db = await target.make();
      await db.query(
        `CREATE TABLE ${table} (tenant_id TEXT NOT NULL, body TEXT NOT NULL)`,
      );
      await db.enableTenantIsolation(table);
      await db.withTenant(TENANT_A, (tx) =>
        tx.query(
          `INSERT INTO ${table} (tenant_id, body) VALUES ($1, 'a1'), ($1, 'a2')`,
          [TENANT_A],
        ),
      );
      await db.withTenant(TENANT_B, (tx) =>
        tx.query(`INSERT INTO ${table} (tenant_id, body) VALUES ($1, 'b1')`, [
          TENANT_B,
        ]),
      );
    });

    afterAll(async () => {
      await target.teardown?.(db);
    });

    it('reports up', async () => {
      expect((await db.health()).status).toBe('up');
    });

    it('binds positional parameters and returns plain rows', async () => {
      const rows = await db.query<{ n: number; s: string }>(
        `SELECT $1::int AS n, $2::text AS s`,
        [7, "it's"],
      );
      expect(rows).toEqual([{ n: 7, s: "it's" }]);
    });

    it('enables tenant isolation idempotently', async () => {
      await expect(db.enableTenantIsolation(table)).resolves.toBeUndefined();
    });

    it('rejects an invalid table name for isolation', async () => {
      await expect(
        db.enableTenantIsolation('x; DROP TABLE users'),
      ).rejects.toThrow();
    });

    it("never returns another tenant's rows, even without a WHERE clause", async () => {
      expect(await bodies(TENANT_A)).toEqual(['a1', 'a2']);
      expect(await bodies(TENANT_B)).toEqual(['b1']);
    });

    it('cannot write a row into another tenant', async () => {
      await expect(
        db.withTenant(TENANT_A, (tx) =>
          tx.query(`INSERT INTO ${table} (tenant_id, body) VALUES ($1, 'x')`, [
            TENANT_B,
          ]),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("cannot update or delete another tenant's rows", async () => {
      await db.withTenant(TENANT_A, (tx) =>
        tx.query(`UPDATE ${table} SET body = body WHERE body = 'b1'`),
      );
      await db.withTenant(TENANT_A, (tx) =>
        tx.query(`DELETE FROM ${table} WHERE body = 'b1'`),
      );
      expect(await bodies(TENANT_B)).toEqual(['b1']);
    });

    it('commits the whole transaction on success', async () => {
      const body = `c-${uniqueId()}`;
      await db.withTenant(TENANT_A, async (tx) => {
        await tx.query(
          `INSERT INTO ${table} (tenant_id, body) VALUES ($1, $2)`,
          [TENANT_A, body],
        );
      });
      expect(await bodies(TENANT_A)).toContain(body);
    });

    it('rolls the whole transaction back when the callback throws', async () => {
      const body = `r-${uniqueId()}`;
      await expect(
        db.withTenant(TENANT_A, async (tx) => {
          await tx.query(
            `INSERT INTO ${table} (tenant_id, body) VALUES ($1, $2)`,
            [TENANT_A, body],
          );
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect(await bodies(TENANT_A)).not.toContain(body);
    });

    it('scopes the tenant setting to the transaction', async () => {
      await db.withTenant(TENANT_A, () => Promise.resolve());
      const [row] = await db.query<{ tenant: string | null }>(
        `SELECT current_setting('app.tenant_id', true) AS tenant`,
      );
      expect(row?.tenant ?? '').toBe('');
    });

    it('rejects an invalid tenant id', async () => {
      await expect(
        db.withTenant('bad tenant' as TenantId, () => Promise.resolve()),
      ).rejects.toThrow();
    });

    if (options.fencedOutsideTenant) {
      it('shows no tenant row outside withTenant', async () => {
        await expect(db.query(`SELECT * FROM ${table}`)).resolves.toEqual([]);
      });
    }
  });
}
