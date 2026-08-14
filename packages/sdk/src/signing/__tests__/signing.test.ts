import { describe, it, expect } from 'vitest';
import { buildCanonicalString, signRequest, createSignedFetch } from '../index';

/**
 * SHARED TEST VECTOR — must stay byte-for-byte in sync with
 * apps/backend/src/common/guards/__tests__/signature.guard.spec.ts.
 * Backend guard and SDK signer are validated against the same canonical
 * string + expected signature; if you change the scheme, update both suites.
 */
const VECTOR = {
  method: 'POST',
  path: '/api/v1/track/secure',
  timestamp: 1700000000,
  nonce: '7f9c24e5-1c4b-4c8a-9d3e-2f6a8b1c0d5e',
  body: '{"events":[{"eventName":"button_click"}]}',
  keyId: 'svc-test',
  secret: 'test-secret-material-for-hmac-vector',
  bodySha256:
    '589fabdc0395d7b757c76d16bed4b9ea44bc8e5d4c6a5a36f2cc4f653daf52e8',
  expectedSignature:
    'c2c9224d1fb33aef647e7e66b3ca45ffc0fcd9f3e538bda90dd8b49128c50f9d',
};

describe('signRequest', () => {
  it('builds the canonical string per docs/api-conventions.md', async () => {
    const canonical = await buildCanonicalString(
      VECTOR.method,
      VECTOR.path,
      String(VECTOR.timestamp),
      VECTOR.nonce,
      VECTOR.body,
    );
    expect(canonical).toBe(
      `POST\n${VECTOR.path}\n${VECTOR.timestamp}\n${VECTOR.nonce}\n${VECTOR.bodySha256}`,
    );
  });

  it('matches the backend signature for the shared test vector', async () => {
    const headers = await signRequest({
      method: VECTOR.method,
      path: VECTOR.path,
      body: VECTOR.body,
      keyId: VECTOR.keyId,
      secret: VECTOR.secret,
      timestamp: VECTOR.timestamp,
      nonce: VECTOR.nonce,
    });
    expect(headers).toEqual({
      'X-Api-Key': VECTOR.keyId,
      'X-Timestamp': String(VECTOR.timestamp),
      'X-Nonce': VECTOR.nonce,
      'X-Signature': VECTOR.expectedSignature,
    });
  });

  it('defaults timestamp to now and nonce to a uuid', async () => {
    const headers = await signRequest({
      method: 'GET',
      path: '/api/v1/thing',
      keyId: 'k',
      secret: 's',
    });
    expect(Number(headers['X-Timestamp'])).toBeCloseTo(
      Math.floor(Date.now() / 1000),
      -1,
    );
    expect(headers['X-Nonce']).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers['X-Signature']).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('createSignedFetch', () => {
  it('adds the four signing headers to the outgoing request', async () => {
    let captured: RequestInit | undefined;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      captured = init;
      return new Response('{}');
    }) as typeof fetch;

    const signedFetch = createSignedFetch({
      keyId: VECTOR.keyId,
      secret: VECTOR.secret,
      fetchImpl,
    });
    await signedFetch(`http://localhost:3100${VECTOR.path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: VECTOR.body,
    });

    const headers = captured?.headers as Record<string, string>;
    expect(headers['X-Api-Key']).toBe(VECTOR.keyId);
    expect(headers['X-Signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('rejects non-string bodies (signature must cover exact bytes)', async () => {
    const signedFetch = createSignedFetch({ keyId: 'k', secret: 's' });
    await expect(
      signedFetch('http://x/api/y', {
        method: 'POST',
        body: new Blob(['x']),
      }),
    ).rejects.toThrow(/must be a string/);
  });
});
