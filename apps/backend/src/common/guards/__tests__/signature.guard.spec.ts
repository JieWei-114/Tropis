import { createHash } from 'crypto';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ERROR_CODES } from '@tropis/shared';
import {
  SignatureGuard,
  buildCanonicalString,
  computeSignature,
} from '../signature.guard';
import { ApiKeyService } from '../api-key.service';
import { ConfigService } from '@nestjs/config';

/**
 * SHARED TEST VECTOR — must stay byte-for-byte in sync with
 * packages/sdk/src/signing/__tests__/signing.test.ts. Both the backend guard
 * and the SDK signer are validated against the same canonical string and
 * expected signature; if you change the signing scheme, update both suites.
 */
const VECTOR = {
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

function mockContext(overrides: {
  headers?: Record<string, string>;
  rawBody?: Buffer;
  method?: string;
  url?: string;
}): ExecutionContext {
  const request = {
    method: overrides.method ?? VECTOR.method,
    originalUrl: overrides.url ?? VECTOR.path,
    url: overrides.url ?? VECTOR.path,
    headers: overrides.headers ?? {},
    rawBody: overrides.rawBody ?? Buffer.from(VECTOR.body),
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function signedHeaders(
  overrides: Partial<Record<string, string>> = {},
): Record<string, string> {
  const timestamp =
    overrides['x-timestamp'] ?? String(Math.floor(Date.now() / 1000));
  const nonce = overrides['x-nonce'] ?? VECTOR.nonce;
  const canonical = buildCanonicalString(
    VECTOR.method,
    VECTOR.path,
    timestamp,
    nonce,
    VECTOR.body,
  );
  return {
    'x-api-key': overrides['x-api-key'] ?? VECTOR.keyId,
    'x-timestamp': timestamp,
    'x-nonce': nonce,
    'x-signature':
      overrides['x-signature'] ?? computeSignature(VECTOR.secret, canonical),
  };
}

describe('SignatureGuard', () => {
  let guard: SignatureGuard;
  let redis: { set: jest.Mock };

  beforeEach(() => {
    redis = { set: jest.fn().mockResolvedValue('OK') };
    const config = {
      get: jest.fn((key: string, def?: string) =>
        key === 'API_KEYS'
          ? JSON.stringify({ [VECTOR.keyId]: VECTOR.secret })
          : def,
      ),
    } as unknown as ConfigService;
    guard = new SignatureGuard(new ApiKeyService(config), redis as never);
  });

  const expectCode = async (headers: Record<string, string>, code: string) => {
    const promise = guard.canActivate(mockContext({ headers }));
    await expect(promise).rejects.toBeInstanceOf(UnauthorizedException);
    await promise.catch((err: UnauthorizedException) => {
      expect((err.getResponse() as { code: string }).code).toBe(code);
    });
  };

  it('shared test vector produces the pinned signature (SDK sync check)', () => {
    const canonical = buildCanonicalString(
      VECTOR.method,
      VECTOR.path,
      VECTOR.timestamp,
      VECTOR.nonce,
      VECTOR.body,
    );
    expect(canonical).toBe(
      `POST\n${VECTOR.path}\n${VECTOR.timestamp}\n${VECTOR.nonce}\n` +
        // SHA256 of the body, lowercase hex
        createHash('sha256').update(VECTOR.body).digest('hex'),
    );
    expect(computeSignature(VECTOR.secret, canonical)).toBe(
      VECTOR.expectedSignature,
    );
  });

  it('accepts a correctly signed request and stores the nonce (SET NX EX)', async () => {
    await expect(
      guard.canActivate(mockContext({ headers: signedHeaders() })),
    ).resolves.toBe(true);
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining('sig:nonce:'),
      '1',
      'EX',
      300,
      'NX',
    );
  });

  it('rejects a missing header set with SIGNATURE_INVALID', async () => {
    await expectCode({}, ERROR_CODES.SIGNATURE_INVALID);
  });

  it('rejects a bad signature with SIGNATURE_INVALID', async () => {
    await expectCode(
      signedHeaders({ 'x-signature': 'f'.repeat(64) }),
      ERROR_CODES.SIGNATURE_INVALID,
    );
  });

  it('rejects an expired timestamp with SIGNATURE_EXPIRED', async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 301);
    await expectCode(
      signedHeaders({ 'x-timestamp': stale }),
      ERROR_CODES.SIGNATURE_EXPIRED,
    );
    // Nonce must not be consumed before the timestamp check passes
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('rejects a replayed nonce with NONCE_REUSED', async () => {
    redis.set.mockResolvedValue(null); // SET NX failed → already seen
    await expectCode(signedHeaders(), ERROR_CODES.NONCE_REUSED);
  });

  it('rejects an unknown API key with API_KEY_UNKNOWN', async () => {
    await expectCode(
      signedHeaders({ 'x-api-key': 'nope' }),
      ERROR_CODES.API_KEY_UNKNOWN,
    );
  });
});
