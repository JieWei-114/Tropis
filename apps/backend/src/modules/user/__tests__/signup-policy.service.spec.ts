import type { ConfigService } from '@nestjs/config';
import { toTenantId } from '../../../common/keyspace';
import type {
  TenantDirectory,
  TenantRecord,
} from '../../../common/tenant/tenant-directory.port';
import { InMemoryRateLimitAdapter } from '../../../infrastructure/ratelimit/__tests__/in-memory-ratelimit.adapter';
import type { RateLimitPort } from '../../../infrastructure/ratelimit/ratelimit.port';
import { SignupPolicyService } from '../services/signup-policy.service';

const ACME = toTenantId('acme');

const tenant = (overrides: Partial<TenantRecord> = {}): TenantRecord => ({
  id: ACME,
  name: 'Acme',
  status: 'active',
  selfSignup: true,
  ...overrides,
});

const DEFAULTS: Record<string, number> = {
  SIGNUP_RATE_LIMIT_IP: 10,
  SIGNUP_RATE_LIMIT_TENANT: 200,
  SIGNUP_RATE_LIMIT_WINDOW_S: 3600,
};

const config = (values: Record<string, number> = {}) =>
  ({
    getOrThrow: (key: string) => values[key] ?? DEFAULTS[key],
  }) as unknown as ConfigService;

function policy(
  record: TenantRecord | null,
  limits: Record<string, number> = {},
  rateLimit: RateLimitPort = new InMemoryRateLimitAdapter(),
) {
  const tenants = { find: jest.fn().mockResolvedValue(record) };
  return new SignupPolicyService(
    tenants as unknown as TenantDirectory,
    rateLimit,
    config(limits),
  );
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'allowed',
    (e: { code?: string }) => e.code,
  );

describe('SignupPolicyService', () => {
  // Reproduces the cross-tenant sign-up: any X-Tenant-ID was accepted, so
  // anyone could create an account in any tenant, registered or not. The
  // refusal is one code for every reason: distinct codes told an anonymous
  // caller which tenant ids exist.
  it.each([
    ['an unregistered tenant', null, 'TENANT_SIGNUP_CLOSED'],
    [
      'a suspended tenant',
      tenant({ status: 'suspended' }),
      'TENANT_SIGNUP_CLOSED',
    ],
    [
      'a tenant closed to self sign-up',
      tenant({ selfSignup: false }),
      'TENANT_SIGNUP_CLOSED',
    ],
    ['an open, active tenant', tenant(), 'allowed'],
  ])('answers %s with %s', async (_label, record, expected) => {
    await expect(code(policy(record).assertAllowed(ACME, 'ip'))).resolves.toBe(
      expected,
    );
  });

  it('limits sign-ups per client address across tenants', async () => {
    const rateLimit = new InMemoryRateLimitAdapter();
    const tenants = { find: jest.fn().mockResolvedValue(tenant()) };
    const svc = new SignupPolicyService(
      tenants as unknown as TenantDirectory,
      rateLimit,
      config({ SIGNUP_RATE_LIMIT_IP: 2 }),
    );
    await svc.assertAllowed(ACME, '203.0.113.9');
    await svc.assertAllowed(toTenantId('globex'), '203.0.113.9');
    await expect(code(svc.assertAllowed(ACME, '203.0.113.9'))).resolves.toBe(
      'RATE_LIMITED',
    );
    await expect(code(svc.assertAllowed(ACME, '198.51.100.1'))).resolves.toBe(
      'allowed',
    );
  });

  it('limits sign-ups per tenant across addresses', async () => {
    const svc = policy(tenant(), { SIGNUP_RATE_LIMIT_TENANT: 2 });
    await svc.assertAllowed(ACME, 'a');
    await svc.assertAllowed(ACME, 'b');
    await expect(code(svc.assertAllowed(ACME, 'c'))).resolves.toBe(
      'RATE_LIMITED',
    );
  });

  it('fails open when the ratelimit store is down', async () => {
    const down = {
      hit: () => Promise.reject(new Error('down')),
      health: jest.fn(),
    } as unknown as RateLimitPort;
    await expect(
      code(policy(tenant(), {}, down).assertAllowed(ACME, 'ip')),
    ).resolves.toBe('allowed');
  });
});
