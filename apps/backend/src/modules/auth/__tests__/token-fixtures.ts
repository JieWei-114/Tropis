import { randomUUID } from 'crypto';
import type { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { AppError } from '../../../common/errors';
import type { Principal } from '../../../common/auth/token-verifier.port';
import type { TenantId } from '../../../common/keyspace';
import { InMemoryKvAdapter } from '../../../infrastructure/kv/__tests__/in-memory-kv.adapter';
import type { TenantRecord } from '../../../common/tenant/tenant-directory.port';
import { UserRole, UserStatus } from '../../user/constants/user.enums';
import type { MemberAccess } from '../../user/services/user.service';
import {
  TokenVerifierService,
  type MemberLookup,
  type TenantLookup,
} from '../services/token-verifier.service';

export const TEST_JWT_SECRET = 'test-secret-at-least-32-characters-long';
export const TEST_TENANT = 'acme';

export const testConfig = (secret = TEST_JWT_SECRET) =>
  ({
    getOrThrow: () => secret,
    get: (_key: string, fallback?: unknown) => fallback,
  }) as unknown as ConfigService;

/** An access token shaped like AuthService issues, with overridable claims. */
export function signAccessToken(
  claims: Record<string, unknown> = {},
  options: jwt.SignOptions = { expiresIn: '15m' },
  secret = TEST_JWT_SECRET,
): string {
  return jwt.sign(
    {
      sub: 'user-1',
      email: 'alice@example.com',
      roles: ['admin'],
      tenantId: TEST_TENANT,
      jti: randomUUID(),
      ...claims,
    },
    secret,
    options,
  );
}

export interface TestVerifier {
  verifier: TokenVerifierService;
  kv: InMemoryKvAdapter;
  members: { findMember: jest.Mock };
  tenants: { find: jest.Mock };
}

export const activeTenant = (
  overrides: Partial<TenantRecord> = {},
): TenantRecord => ({
  id: TEST_TENANT as TenantId,
  name: 'Acme',
  status: 'active',
  selfSignup: true,
  ...overrides,
});

/**
 * The real TokenVerifierService over an in-memory kv and stub member and
 * tenant directories. The member holds `roles` (admin by default).
 */
export function testTokenVerifier(
  status: UserStatus | null = UserStatus.ACTIVE,
  roles: UserRole[] = [UserRole.ADMIN],
  tenant: TenantRecord | null = activeTenant(),
): TestVerifier {
  const kv = new InMemoryKvAdapter();
  const member: MemberAccess | null = status
    ? { status, roles, tokenVersion: 0 }
    : null;
  const members = { findMember: jest.fn().mockResolvedValue(member) };
  const tenants = { find: jest.fn().mockResolvedValue(tenant) };
  const verifier = new TokenVerifierService(
    testConfig(),
    kv,
    members as unknown as MemberLookup,
    tenants as unknown as TenantLookup,
  );
  return { verifier, kv, members, tenants };
}

/**
 * Credentials as the RPC authentication interceptor would record them for a
 * token signed with TEST_JWT_SECRET, resolved synchronously (signature and
 * expiry only) for controller unit tests.
 */
export function credentialsFor(token?: string): {
  token?: string;
  principal?: Principal;
  error?: unknown;
} {
  if (!token) return {};
  try {
    const c = jwt.verify(token, TEST_JWT_SECRET) as {
      sub?: string;
      email?: string;
      roles?: string[];
      tenantId?: string;
      jti?: string;
      exp?: number;
    };
    return {
      token,
      principal: {
        userId: String(c.sub),
        email: String(c.email ?? ''),
        roles: c.roles ?? [],
        tenantId: c.tenantId as TenantId,
        jti: String(c.jti),
        exp: Number(c.exp),
      },
    };
  } catch {
    return { token, error: new AppError('AUTH_TOKEN_INVALID') };
  }
}
