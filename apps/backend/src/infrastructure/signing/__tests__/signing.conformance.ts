import type { ConformanceTarget } from '../../capability/__tests__/conformance-helpers';
import type { SignatureInput, SigningPort } from '../signing.port';

/**
 * SHARED TEST VECTOR — byte-for-byte the one in
 * src/common/guards/__tests__/signature.guard.spec.ts,
 * packages/sdk/src/signing/__tests__/signing.test.ts and
 * services/rust/signing/src/domain/signature.rs. Every adapter must produce the
 * pinned signature for it.
 */
export const SIGNING_VECTOR = {
  method: 'POST',
  path: '/api/v1/track/secure',
  timestamp: '1700000000',
  nonce: '7f9c24e5-1c4b-4c8a-9d3e-2f6a8b1c0d5e',
  body: '{"events":[{"eventName":"button_click"}]}',
  keyId: 'svc-test',
  secret: 'test-secret-material-for-hmac-vector',
  expectedSignature:
    'c2c9224d1fb33aef647e7e66b3ca45ffc0fcd9f3e538bda90dd8b49128c50f9d',
};

const vectorInput = (
  overrides: Partial<SignatureInput> = {},
): SignatureInput => ({
  method: SIGNING_VECTOR.method,
  path: SIGNING_VECTOR.path,
  timestamp: SIGNING_VECTOR.timestamp,
  nonce: SIGNING_VECTOR.nonce,
  body: Buffer.from(SIGNING_VECTOR.body),
  keyId: SIGNING_VECTOR.keyId,
  ...overrides,
});

/** A request inside the ±300 s window, for adapters that check freshness. */
const freshInput = (overrides: Partial<SignatureInput> = {}) =>
  vectorInput({
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...overrides,
  });

/**
 * Behaviour every SigningPort adapter must share. The adapter under test must
 * know SIGNING_VECTOR.keyId → SIGNING_VECTOR.secret (native: via API_KEYS).
 */
export function describeSigningPort(
  name: string,
  target: ConformanceTarget<SigningPort>,
): void {
  describe(`SigningPort conformance: ${name}`, () => {
    let port: SigningPort;
    const secret = SIGNING_VECTOR.secret;

    beforeAll(async () => {
      port = await target.make();
    });

    afterAll(async () => {
      await target.teardown?.(port);
    });

    it('signs the shared test vector to the pinned signature', async () => {
      await expect(port.sign(vectorInput(), secret)).resolves.toBe(
        SIGNING_VECTOR.expectedSignature,
      );
    });

    it('accepts the signature it produced', async () => {
      const input = freshInput();
      const signature = await port.sign(input, secret);
      await expect(port.verify(input, signature, secret)).resolves.toBe(true);
    });

    it('rejects a signature over a different body', async () => {
      const signature = await port.sign(freshInput(), secret);
      await expect(
        port.verify(freshInput({ body: Buffer.from('{}') }), signature, secret),
      ).resolves.toBe(false);
    });

    it('rejects a signature over a different path or method', async () => {
      const signature = await port.sign(freshInput(), secret);
      await expect(
        port.verify(freshInput({ path: '/api/v1/other' }), signature, secret),
      ).resolves.toBe(false);
      await expect(
        port.verify(freshInput({ method: 'PUT' }), signature, secret),
      ).resolves.toBe(false);
    });

    it('rejects a malformed signature', async () => {
      await expect(port.verify(freshInput(), 'not-hex', secret)).resolves.toBe(
        false,
      );
      await expect(
        port.verify(freshInput(), 'f'.repeat(64), secret),
      ).resolves.toBe(false);
    });

    it('reports up', async () => {
      await expect(port.health()).resolves.toMatchObject({ status: 'up' });
    });
  });
}
