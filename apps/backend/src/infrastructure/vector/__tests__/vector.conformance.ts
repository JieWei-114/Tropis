import {
  TENANT_A,
  TENANT_B,
  type ConformanceTarget,
} from '../../capability/__tests__/conformance-helpers';
import { VECTOR_DIMENSIONS, type VectorPort } from '../vector.port';

/** A unit vector along `axis`, optionally tilted toward axis+1. */
export const axisVector = (axis: number, tilt = 0): number[] => {
  const v = new Array<number>(VECTOR_DIMENSIONS).fill(0);
  v[axis] = 1;
  if (tilt) v[axis + 1] = tilt;
  return v;
};

/** Behaviour every VectorPort adapter must share. */
export function describeVectorPort(
  name: string,
  target: ConformanceTarget<VectorPort>,
): void {
  describe(`VectorPort conformance: ${name}`, () => {
    let port: VectorPort;
    const collection = `conformance-${Date.now()}`;

    beforeAll(async () => {
      port = await target.make();
    });

    afterAll(async () => {
      await target.teardown?.(port);
    });

    it('stores and reads back an embedding', async () => {
      await port.upsert(TENANT_A, collection, 'a', axisVector(0));
      const stored = await port.get(TENANT_A, collection, 'a');
      expect(stored).toHaveLength(VECTOR_DIMENSIONS);
      expect(stored![0]).toBeCloseTo(1);
    });

    it('replaces the embedding on a second upsert', async () => {
      await port.upsert(TENANT_A, collection, 'r', axisVector(0));
      await port.upsert(TENANT_A, collection, 'r', axisVector(3));
      const stored = await port.get(TENANT_A, collection, 'r');
      expect(stored![3]).toBeCloseTo(1);
      expect(stored![0]).toBeCloseTo(0);
      await port.delete(TENANT_A, collection, 'r');
    });

    it('returns the nearest items first, excluding the given ids', async () => {
      await port.upsert(TENANT_A, collection, 'near', axisVector(0, 0.1));
      await port.upsert(TENANT_A, collection, 'far', axisVector(5));

      const matches = await port.similar(
        TENANT_A,
        collection,
        axisVector(0),
        2,
        { excludeIds: ['a'] },
      );

      expect(matches.map((m) => m.id)).toEqual(['near', 'far']);
      expect(matches[0].distance).toBeLessThan(matches[1].distance);
    });

    it("never returns or deletes another tenant's items", async () => {
      await port.upsert(TENANT_B, collection, 'a', axisVector(0));

      const matches = await port.similar(
        TENANT_B,
        collection,
        axisVector(0),
        10,
      );
      expect(matches.map((m) => m.id)).toEqual(['a']);

      await port.delete(TENANT_B, collection, 'a');
      await expect(port.get(TENANT_A, collection, 'a')).resolves.not.toBeNull();
      await expect(port.get(TENANT_B, collection, 'a')).resolves.toBeNull();
    });

    it('treats deleting an absent item as success', async () => {
      await expect(
        port.delete(TENANT_A, collection, 'never-stored'),
      ).resolves.toBeUndefined();
    });

    it('rejects an embedding of the wrong width', async () => {
      await expect(
        port.upsert(TENANT_A, collection, 'x', [1, 2, 3]),
      ).rejects.toThrow(/Embedding must be/);
    });

    it('reports up', async () => {
      await expect(port.health()).resolves.toMatchObject({ status: 'up' });
    });
  });
}
