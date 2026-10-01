import { randomUUID } from 'crypto';
import { toTenantId } from '../../../common/keyspace';
import type { ConformanceTarget } from '../../capability/__tests__/conformance-helpers';
import type { ObjectsPort } from '../objects.port';

/** Behaviour every ObjectsPort adapter must share. */
export function describeObjectsPort(
  name: string,
  target: ConformanceTarget<ObjectsPort>,
): void {
  describe(`ObjectsPort conformance: ${name}`, () => {
    let port: ObjectsPort;
    const A = toTenantId('conf-a');
    const B = toTenantId('conf-b');

    beforeAll(async () => {
      port = await target.make();
    });

    afterAll(async () => {
      await target.teardown?.(port);
    });

    it('stores an object that its presigned URL serves back', async () => {
      const key = `conformance/${randomUUID()}.txt`;
      const body = Buffer.from('hello objects');
      await port.put(A, key, body, body.length, 'text/plain');

      const res = await fetch(await port.presignedGet(A, key, 60));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/plain');
      expect(await res.text()).toBe('hello objects');
    });

    it('serves a presigned GET with the requested Content-Disposition', async () => {
      const key = `conformance/${randomUUID()}.png`;
      const body = Buffer.from('not really a png');
      await port.put(A, key, body, body.length, 'image/png');

      const res = await fetch(
        await port.presignedGet(A, key, 60, {
          contentDisposition: 'attachment; filename="avatar.png"',
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toBe(
        'attachment; filename="avatar.png"',
      );
    });

    it('deletes an object so its URL stops serving it', async () => {
      const key = `conformance/${randomUUID()}.txt`;
      const body = Buffer.from('bye');
      await port.put(A, key, body, body.length);
      await port.delete(A, key);

      const res = await fetch(await port.presignedGet(A, key, 60));
      expect(res.status).toBe(404);
    });

    it("never serves or deletes another tenant's object under the same key", async () => {
      const key = `conformance/${randomUUID()}.txt`;
      const body = Buffer.from('tenant a only');
      await port.put(A, key, body, body.length);

      const other = await fetch(await port.presignedGet(B, key, 60));
      expect(other.status).toBe(404);
      await port.delete(B, key);
      const own = await fetch(await port.presignedGet(A, key, 60));
      expect(own.status).toBe(200);
    });

    it('rejects a key that climbs out of the tenant prefix', async () => {
      const body = Buffer.from('x');
      await expect(
        port.put(A, '../conf-b/escape.txt', body, body.length),
      ).rejects.toThrow(/Invalid object key/);
    });

    it('treats deleting an absent key as success', async () => {
      await expect(port.delete(A, `conformance/${randomUUID()}`)).resolves.toBe(
        undefined,
      );
    });

    it('reports up', async () => {
      await expect(port.health()).resolves.toMatchObject({ status: 'up' });
    });
  });
}
