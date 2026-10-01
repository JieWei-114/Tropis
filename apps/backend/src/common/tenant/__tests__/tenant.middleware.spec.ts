import type { Request, Response } from 'express';
import { AppError } from '../../errors';
import type { TokenVerifier } from '../../auth/token-verifier.port';
import {
  TenantMiddleware,
  type TenantResolvedRequest,
} from '../tenant.middleware';
import {
  TEST_TENANT,
  signAccessToken,
  testTokenVerifier,
} from '../../../modules/auth/__tests__/token-fixtures';
import { TOKEN_REVOKED_KEY } from '../../../modules/auth/constants/auth.constants';

describe('TenantMiddleware', () => {
  let middleware: TenantMiddleware;
  let kv: ReturnType<typeof testTokenVerifier>['kv'];

  const run = async (
    headers: Record<string, string>,
    query: Record<string, string> = {},
  ) => {
    const req = { headers, query } as unknown as Request &
      TenantResolvedRequest;
    const next = jest.fn();
    await middleware.use(req, {} as Response, next);
    expect(next).toHaveBeenCalled();
    return req;
  };

  const errorCode = (req: TenantResolvedRequest) =>
    (req.tenantError as AppError | undefined)?.code;

  beforeEach(() => {
    const t = testTokenVerifier();
    kv = t.kv;
    middleware = new TenantMiddleware(t.verifier as TokenVerifier);
  });

  it('takes the tenant from a verified token', async () => {
    const req = await run({ authorization: `Bearer ${signAccessToken()}` });
    expect(req.tenantId).toBe(TEST_TENANT);
  });

  it('accepts a header that names the token tenant', async () => {
    const req = await run({
      authorization: `Bearer ${signAccessToken()}`,
      'x-tenant-id': TEST_TENANT,
    });
    expect(req.tenantId).toBe(TEST_TENANT);
  });

  it('rejects a header that contradicts the token tenant', async () => {
    const req = await run({
      authorization: `Bearer ${signAccessToken()}`,
      'x-tenant-id': 'globex',
    });
    expect(req.tenantId).toBeUndefined();
    expect(errorCode(req)).toBe('TENANT_MISMATCH');
  });

  it('does not take the tenant from a revoked token', async () => {
    await kv.set(TOKEN_REVOKED_KEY.global('j1'), true, { ttlSeconds: 60 });
    const req = await run({
      authorization: `Bearer ${signAccessToken({ jti: 'j1' })}`,
    });
    expect(req.tenantId).toBeUndefined();
  });

  it('uses the header, or the query hint, without a token', async () => {
    expect((await run({ 'x-tenant-id': 'globex' })).tenantId).toBe('globex');
    expect((await run({}, { tenant: 'initech' })).tenantId).toBe('initech');
  });

  it('resolves no tenant (no default) without a token or hint', async () => {
    const req = await run({});
    expect(req.tenantId).toBeUndefined();
    expect(req.tenantError).toBeUndefined();
  });

  it('records TENANT_INVALID for a malformed hint', async () => {
    expect(errorCode(await run({ 'x-tenant-id': 'a:b c' }))).toBe(
      'TENANT_INVALID',
    );
  });
});
