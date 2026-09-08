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
 *        make promote-admin EMAIL=<email>
 *
 * The tenant defaults to 'default'. Emails are unique per tenant, not
 * globally, so matching on email alone could promote the wrong user.
 */
import mongoose from 'mongoose';

const URI =
  process.env.MONGODB_URI ??
  'mongodb://127.0.0.1:27018/tropis?replicaSet=rs0&directConnection=true';

async function main(): Promise<void> {
  const email = (process.argv[2] ?? process.env.EMAIL ?? '')
    .trim()
    .toLowerCase();
  const tenantId = (
    process.argv[3] ??
    process.env.TENANT_ID ??
    'default'
  ).trim();
  if (!email) {
    console.error(
      'Usage: promote-admin <email> [tenantId]   (or EMAIL=<email> TENANT_ID=<tenant>)',
    );
    process.exit(1);
  }

  await mongoose.connect(URI);
  try {
    const users = mongoose.connection.collection('users');

    const existing = await users.findOne({ email, tenantId });
    if (!existing) {
      console.error(
        `No user with email ${email} in tenant ${tenantId}. Register or seed first.`,
      );
      process.exit(1);
    }
    if ((existing.roles as string[] | undefined)?.includes('admin')) {
      console.log(`${email} already has the admin role.`);
      return;
    }

    // $addToSet, not $set: $set would replace the array and silently drop the
    // roles the user already has (e.g. the default `editor`).
    await users.updateOne(
      { email, tenantId },
      { $addToSet: { roles: 'admin' } },
    );
    console.log(
      `${email} is now an admin. Sign out and back in — the role is read from the JWT.`,
    );
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err: Error) => {
  console.error(`promote-admin failed: ${err.message}`);
  process.exit(1);
});
