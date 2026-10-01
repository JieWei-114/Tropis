/**
 * Registers a tenant (or updates it). A tenant must be registered before
 * anyone can sign up or log in to it.
 *
 * Usage: make tenant-create ID=<tenantId> NAME=<name> [SELF_SIGNUP=true] [STATUS=active|suspended]
 *        pnpm --filter @tropis/backend tenant-create <tenantId> <name> [selfSignup] [status]
 *
 * SELF_SIGNUP=true lets anyone create an account in the tenant (with the
 * least-privilege `member` role); otherwise only an admin of the tenant can
 * add users.
 */
import { registerTenant, withDb } from './lib/db';

async function main(): Promise<void> {
  const id = (process.argv[2] ?? process.env.ID ?? '').trim();
  const name = (process.argv[3] ?? process.env.NAME ?? id).trim();
  const selfSignup =
    (process.argv[4] ?? process.env.SELF_SIGNUP ?? 'false').trim() === 'true';
  const status = (process.argv[5] ?? process.env.STATUS ?? 'active').trim();
  if (!id || (status !== 'active' && status !== 'suspended')) {
    console.error(
      'Usage: tenant-create <tenantId> [name] [selfSignup=true|false] [status=active|suspended]',
    );
    process.exit(1);
  }

  await withDb(() => registerTenant({ id, name, selfSignup, status }));
  console.log(
    `Tenant ${id} registered (name: ${name}, status: ${status}, self sign-up: ${selfSignup}).`,
  );
}

main().catch((err: Error) => {
  console.error(`tenant-create failed: ${err.message}`);
  process.exit(1);
});
