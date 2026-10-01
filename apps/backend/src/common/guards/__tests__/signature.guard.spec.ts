import { createHash } from 'crypto';
import { ExecutionContext } from '@nestjs/common';
import { AppError } from '../../errors/app-error';
import { ERROR_CODES } from '@tropis/shared';
import {
  SignatureGuard,
  buildCanonicalString,
  computeSignature,
} from '../signature.guard';
import { ApiKeyService } from '../api-key.service';
import { ConfigService } from '@nestjs/config';
import { InMemoryDedupAdapter } from '../../../infrastructure/dedup/__tests__/in-memory-dedup.adapter';
import { InprocessSigningAdapter } from '../../../infrastructure/signing/adapters/inprocess/inprocess-signing.adapter';
import { SIGNATURE_NONCE_KEY } from '../signature.constants';

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

const KEY_TENANT = 'acme';

type MockRequest = Record<string, unknown> & {
  tenantId?: string;
  tenantError?: unknown;
};

function mockContext(
  overrides: {
    headers?: Record<string, string>;
    rawBody?: Buffer;
    method?: string;
    url?: string;
  },
  request: MockRequest = {},
): ExecutionContext {
  Object.assign(request, {
    method: overrides.method ?? VECTOR.method,
    originalUrl: overrides.url ?? VECTOR.path,
    url: overrides.url ?? VECTOR.path,
    headers: overrides.headers ?? {},
    rawBody: overrides.rawBody ?? Buffer.from(VECTOR.body),
    query: {},
  });
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
  let dedup: InMemoryDedupAdapter;
  let tenants: { find: jest.Mock };

  beforeEach(() => {
    dedup = new InMemoryDedupAdapter();
    tenants = {
      find: jest.fn().mockResolvedValue({
        id: KEY_TENANT,
        name: 'Acme',
        status: 'active',
        selfSignup: false,
      }),
    };
    const config = {
      getOrThrow: jest.fn((key: string) =>
        key === 'API_KEYS'
          ? JSON.stringify({
              [VECTOR.keyId]: { secret: VECTOR.secret, tenantId: KEY_TENANT },
            })
          : undefined,
      ),
    } as unknown as ConfigService;
    guard = new SignatureGuard(
      new ApiKeyService(config),
      new InprocessSigningAdapter(),
      dedup,
      tenants,
    );
  });

  const expectCode = async (headers: Record<string, string>, code: string) => {
    const promise = guard.canActivate(mockContext({ headers }));
    await expect(promise).rejects.toBeInstanceOf(AppError);
    await expect(promise).rejects.toMatchObject({ code, httpStatus: 401 });
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

  it('accepts a correctly signed request and claims the nonce for 300 s', async () => {
    const claim = jest.spyOn(dedup, 'claim');
    await expect(
      guard.canActivate(mockContext({ headers: signedHeaders() })),
    ).resolves.toBe(true);
    expect(claim).toHaveBeenCalledWith(
      SIGNATURE_NONCE_KEY.global(VECTOR.keyId, VECTOR.nonce),
      300,
    );
  });

  it('does not consume the nonce of a request with a bad signature', async () => {
    const claim = jest.spyOn(dedup, 'claim');
    await expectCode(
      signedHeaders({ 'x-signature': 'f'.repeat(64) }),
      ERROR_CODES.SIGNATURE_INVALID,
    );
    expect(claim).not.toHaveBeenCalled();
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
    await expect(
      dedup.claim(SIGNATURE_NONCE_KEY.global(VECTOR.keyId, VECTOR.nonce), 300),
    ).resolves.toBe(true);
  });

  it('rejects a replayed nonce with NONCE_REUSED', async () => {
    const headers = signedHeaders();
    await expect(guard.canActivate(mockContext({ headers }))).resolves.toBe(
      true,
    );
    await expectCode(headers, ERROR_CODES.NONCE_REUSED);
  });

  // Reproduces the gap: the signed tier took its tenant from the unsigned
  // X-Tenant-ID header, so any key holder could write into any tenant.
  it('runs the request in the tenant the API key is bound to', async () => {
    const request: MockRequest = {};
    await expect(
      guard.canActivate(mockContext({ headers: signedHeaders() }, request)),
    ).resolves.toBe(true);
    expect(request.tenantId).toBe(KEY_TENANT);
  });

  it('accepts a tenant header that names the key tenant', async () => {
    const request: MockRequest = {};
    const headers = { ...signedHeaders(), 'x-tenant-id': KEY_TENANT };
    await expect(
      guard.canActivate(mockContext({ headers }, request)),
    ).resolves.toBe(true);
    expect(request.tenantId).toBe(KEY_TENANT);
  });

  it('rejects a tenant header naming another tenant, without consuming the nonce', async () => {
    const claim = jest.spyOn(dedup, 'claim');
    const request: MockRequest = { tenantId: 'globex' };
    const headers = { ...signedHeaders(), 'x-tenant-id': 'globex' };
    const promise = guard.canActivate(mockContext({ headers }, request));
    await expect(promise).rejects.toMatchObject({
      code: 'TENANT_MISMATCH',
      httpStatus: 403,
    });
    expect(claim).not.toHaveBeenCalled();
  });

  it('ignores an API_KEYS entry that is not bound to a tenant', async () => {
    const config = {
      getOrThrow: jest.fn((key: string) =>
        key === 'API_KEYS'
          ? JSON.stringify({ [VECTOR.keyId]: VECTOR.secret })
          : undefined,
      ),
    } as unknown as ConfigService;
    guard = new SignatureGuard(
      new ApiKeyService(config),
      new InprocessSigningAdapter(),
      dedup,
      tenants,
    );
    await expectCode(signedHeaders(), ERROR_CODES.API_KEY_UNKNOWN);
  });

  // Reproduces the gap: the key of a suspended tenant kept working.
  it('rejects a key whose tenant is suspended, without consuming the nonce', async () => {
    tenants.find.mockResolvedValue({
      id: KEY_TENANT,
      name: 'Acme',
      status: 'suspended',
      selfSignup: false,
    });
    const headers = signedHeaders();
    await expect(
      guard.canActivate(mockContext({ headers })),
    ).rejects.toMatchObject({ code: 'TENANT_INACTIVE' });
    tenants.find.mockResolvedValue({
      id: KEY_TENANT,
      name: 'Acme',
      status: 'active',
      selfSignup: false,
    });
    await expect(guard.canActivate(mockContext({ headers }))).resolves.toBe(
      true,
    );
  });

  it('rejects a key whose tenant is not registered', async () => {
    tenants.find.mockResolvedValue(null);
    await expect(
      guard.canActivate(mockContext({ headers: signedHeaders() })),
    ).rejects.toMatchObject({ code: 'TENANT_NOT_FOUND' });
  });

  it('rejects an unknown API key with API_KEY_UNKNOWN', async () => {
    await expectCode(
      signedHeaders({ 'x-api-key': 'nope' }),
      ERROR_CODES.API_KEY_UNKNOWN,
    );
  });
});
