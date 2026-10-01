/**
 * Grants the `admin` role to an existing user, by email.
 *
 * Deliberately a local script, not an API: the first admin cannot be granted
 * through the admin-only roles endpoint (chicken-and-egg), and granting a role
 * from a request payload on the public self-service registration path would be
 * a privilege-escalation hole. This runs against the database directly, so it
 * requires host/DB access — a trust level the network API does not have.
 *
 * Usage: pnpm --filter @tropis/backend promote-admin <email> [tenantId]
 *        make promote-admin EMAIL=<email> [TENANT_ID=<tenant>]
 *
 * The tenant defaults to 'dev', the tenant the seeder and helm use. Emails
 * are unique per tenant, not globally, so matching on email alone could
 * promote the wrong user.
 */
import { grantAdmin, withDb } from './lib/db';

async function main(): Promise<void> {
  const email = (process.argv[2] ?? process.env.EMAIL ?? '')
    .trim()
    .toLowerCase();
  const tenantId = (process.argv[3] ?? process.env.TENANT_ID ?? 'dev').trim();
  if (!email) {
    console.error(
      'Usage: promote-admin <email> [tenantId]   (or EMAIL=<email> TENANT_ID=<tenant>)',
    );
    process.exit(1);
  }

  const outcome = await withDb(() => grantAdmin(tenantId, email));
  if (outcome === 'missing') {
    console.error(
      `No user with email ${email} in tenant ${tenantId}. Register or seed first.`,
    );
    process.exit(1);
  }
  console.log(
    outcome === 'already'
      ? `${email} already has the admin role.`
      : `${email} is now an admin. Roles are read from the member record, so ` +
          `it applies on the next request.`,
  );
}

main().catch((err: Error) => {
  console.error(`promote-admin failed: ${err.message}`);
  process.exit(1);
});
