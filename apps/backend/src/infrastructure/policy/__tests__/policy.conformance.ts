import type { ConformanceTarget } from '../../capability/__tests__/conformance-helpers';
import type { PolicyPort } from '../policy.port';

export interface PolicyConformanceTargets {
  /** A port over an engine loaded with the repository's authz policy. */
  live: ConformanceTarget<PolicyPort>;
  /** A port whose engine cannot be reached. */
  unreachable: ConformanceTarget<PolicyPort>;
}

/**
 * Behaviour every PolicyPort adapter must share: decisions follow the
 * loaded policy (infra/opa/authz.rego), anything the policy does not grant
 * is denied, and an engine that cannot answer rejects with
 * SERVICE_UNAVAILABLE (retryable) instead of reporting a denial.
 */
export function describePolicyPort(
  adapter: string,
  targets: PolicyConformanceTargets,
): void {
  describe(`PolicyPort conformance: ${adapter}`, () => {
    describe('with a reachable engine', () => {
      let policy: PolicyPort;

      beforeAll(async () => {
        policy = await targets.live.make();
      });

      afterAll(async () => {
        await targets.live.teardown?.(policy);
      });

      it('reports up', async () => {
        expect((await policy.health()).status).toBe('up');
      });

      it('allows what a role is granted', async () => {
        await expect(
          policy.allow({ roles: ['viewer'], resource: 'user', action: 'read' }),
        ).resolves.toBe(true);
        await expect(
          policy.allow({
            roles: ['admin'],
            resource: 'user',
            action: 'delete',
          }),
        ).resolves.toBe(true);
      });

      it('allows when any one of several roles grants the action', async () => {
        await expect(
          policy.allow({
            roles: ['viewer', 'admin'],
            resource: 'user',
            action: 'delete',
          }),
        ).resolves.toBe(true);
      });

      it.each([
        ['an action the role lacks', ['viewer'], 'user', 'delete'],
        ['no roles', [], 'user', 'read'],
        ['an unknown role', ['root'], 'user', 'read'],
        ['an unknown resource', ['admin'], 'no-such-resource', 'read'],
        ['an unknown action', ['admin'], 'user', 'no-such-action'],
      ])('denies %s', async (_label, roles, resource, action) => {
        await expect(policy.allow({ roles, resource, action })).resolves.toBe(
          false,
        );
      });
    });

    describe('with an unreachable engine', () => {
      let policy: PolicyPort;

      beforeAll(async () => {
        policy = await targets.unreachable.make();
      });

      afterAll(async () => {
        await targets.unreachable.teardown?.(policy);
      });

      it('reports down', async () => {
        expect((await policy.health()).status).toBe('down');
      });

      it('rejects with SERVICE_UNAVAILABLE instead of denying', async () => {
        await expect(
          policy.allow({ roles: ['admin'], resource: 'user', action: 'read' }),
        ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      });
    });
  });
}
