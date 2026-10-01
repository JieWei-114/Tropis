import {
  TENANT_A,
  TENANT_B,
  type ConformanceTarget,
} from '../../capability/__tests__/conformance-helpers';
import type { OlapPort } from '../olap.port';

export interface OlapConformanceTarget extends ConformanceTarget<OlapPort> {
  /** Columns tenant_id String, id String, n Int64; sorting key (tenant_id, id). */
  table: string;
  /** Same columns, sorting key (id, tenant_id). */
  misorderedTable: string;
}

/** Behaviour every OlapPort adapter must share. */
export function describeOlapPort(
  name: string,
  target: OlapConformanceTarget,
): void {
  describe(`OlapPort conformance: ${name}`, () => {
    let port: OlapPort;

    beforeAll(async () => {
      port = await target.make();
      await port.insert(TENANT_A, target.table, [
        { id: 'a1', n: 1 },
        { id: 'a2', n: 2 },
      ]);
      await port.insert(TENANT_B, target.table, [{ id: 'b1', n: 5 }]);
    });

    afterAll(async () => {
      await target.teardown?.(port);
    });

    it('stamps the tenant on inserted rows', async () => {
      const rows = await port.queryGlobal<{ tenant_id: string; id: string }>(
        `SELECT tenant_id, id FROM ${target.table} ORDER BY id`,
      );
      expect(rows).toEqual([
        { tenant_id: TENANT_A, id: 'a1' },
        { tenant_id: TENANT_A, id: 'a2' },
        { tenant_id: TENANT_B, id: 'b1' },
      ]);
    });

    it('rejects a row that names another tenant', async () => {
      await expect(
        port.insert(TENANT_A, target.table, [
          { tenant_id: TENANT_B, id: 'x', n: 0 },
        ]),
      ).rejects.toThrow(/different tenant/);
    });

    it('rejects tenant rows in a table whose key does not lead with tenant_id', async () => {
      await expect(
        port.insert(TENANT_A, target.misorderedTable, [{ id: 'x', n: 0 }]),
      ).rejects.toThrow(/lead with tenant_id/);
    });

    it("never returns another tenant's rows", async () => {
      const rows = await port.query<{ id: string }>(
        TENANT_B,
        `SELECT id FROM ${target.table} WHERE tenant_id = {tenant_id:String} ORDER BY id`,
      );
      expect(rows.map((r) => r.id)).toEqual(['b1']);
    });

    it('rejects a query that only mentions the placeholder', async () => {
      await expect(
        port.query(
          TENANT_A,
          `SELECT id FROM ${target.table} WHERE {tenant_id:String} != ''`,
        ),
      ).rejects.toThrow(/tenant_id = \{tenant_id:String\}/);
    });

    it("returns only the given tenant's rows", async () => {
      const rows = await port.query<{ id: string }>(
        TENANT_A,
        `SELECT id FROM ${target.table} WHERE tenant_id = {tenant_id:String} ORDER BY id`,
      );
      expect(rows.map((r) => r.id)).toEqual(['a1', 'a2']);
    });

    it('binds caller parameters next to the tenant', async () => {
      const rows = await port.query<{ id: string }>(
        TENANT_B,
        `SELECT id FROM ${target.table} WHERE tenant_id = {tenant_id:String} AND n >= {min:Int64}`,
        { min: 3 },
      );
      expect(rows.map((r) => r.id)).toEqual(['b1']);
    });

    it('rejects a tenant-scoped query that does not reference the tenant', async () => {
      await expect(
        port.query(TENANT_A, `SELECT id FROM ${target.table}`),
      ).rejects.toThrow(/tenant_id = \{tenant_id:String\}/);
    });

    it('rejects a placeholder hidden in a comment', async () => {
      await expect(
        port.query(
          TENANT_A,
          `SELECT id FROM ${target.table} -- WHERE tenant_id = {tenant_id:String}`,
        ),
      ).rejects.toThrow(/tenant_id = \{tenant_id:String\}/);
    });

    it('rejects a caller-supplied tenant_id parameter', async () => {
      await expect(
        port.query(
          TENANT_A,
          `SELECT id FROM ${target.table} WHERE tenant_id = {tenant_id:String}`,
          { tenant_id: TENANT_B },
        ),
      ).rejects.toThrow(/bound by the OLAP port/);
    });

    it('runs global queries unfiltered', async () => {
      const rows = await port.queryGlobal<{ c: string | number }>(
        `SELECT count() AS c FROM ${target.table}`,
      );
      expect(Number(rows[0].c)).toBe(3);
    });

    it('reports up', async () => {
      await expect(port.health()).resolves.toMatchObject({ status: 'up' });
    });
  });
}
