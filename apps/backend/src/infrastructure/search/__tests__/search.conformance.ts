import {
  TENANT_A,
  TENANT_B,
  type ConformanceTarget,
} from '../../capability/__tests__/conformance-helpers';
import type { SearchPort } from '../search.port';

export interface SearchConformanceTarget extends ConformanceTarget<SearchPort> {
  /** Makes writes visible to queries (a no-op for engines that are immediate). */
  refresh?(index: string): Promise<void>;
}

/** Behaviour every SearchPort adapter must share. */
export function describeSearchPort(
  name: string,
  target: SearchConformanceTarget,
): void {
  describe(`SearchPort conformance: ${name}`, () => {
    let port: SearchPort;
    const index = `conformance-${Date.now()}`;
    const refresh = () => target.refresh?.(index) ?? Promise.resolve();
    const fields = ['name', 'email'];

    beforeAll(async () => {
      port = await target.make();
      await port.ensureIndex(index, {
        id: { type: 'keyword' },
        name: { type: 'text' },
        email: { type: 'text' },
      });
    });

    afterAll(async () => {
      await target.teardown?.(port);
    });

    it('finds an indexed document and hides the tenant field', async () => {
      await port.index(TENANT_A, index, 'u1', {
        id: 'u1',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
      });
      await refresh();

      const result = await port.query(TENANT_A, index, 'lovelace', { fields });

      expect(result.total).toBe(1);
      expect(result.hits[0]).toEqual({
        id: 'u1',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
      });
    });

    it("never returns another tenant's documents", async () => {
      await port.index(TENANT_B, index, 'u2', {
        id: 'u2',
        name: 'Ada Byron',
        email: 'byron@example.com',
      });
      await refresh();

      const a = await port.query(TENANT_A, index, 'ada', { fields });
      const b = await port.query(TENANT_B, index, 'ada', { fields });

      expect(a.hits.map((h) => h.id)).toEqual(['u1']);
      expect(b.hits.map((h) => h.id)).toEqual(['u2']);
    });

    it('keeps the same id apart per tenant', async () => {
      await port.index(TENANT_B, index, 'u1', {
        id: 'u1',
        name: 'Grace Hopper',
        email: 'grace@example.com',
      });
      await port.remove(TENANT_B, index, 'u1');
      await refresh();

      const a = await port.query(TENANT_A, index, 'lovelace', { fields });
      expect(a.total).toBe(1);
    });

    it('treats removing an absent document as success', async () => {
      await expect(
        port.remove(TENANT_A, index, 'never-indexed'),
      ).resolves.toBeUndefined();
    });

    it('rejects a document that sets the tenant field itself', async () => {
      await expect(
        port.index(TENANT_A, index, 'x', { tenantId: TENANT_B }),
      ).rejects.toThrow(/set by the search port/);
    });

    it('reports up', async () => {
      await expect(port.health()).resolves.toMatchObject({ status: 'up' });
    });
  });
}
