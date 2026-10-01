/**
 * Direct database access for the operator scripts (tenant-create,
 * promote-admin, seed). These run with host/DB access, a trust level the
 * network API does not have, which is why tenants and the first admin are
 * provisioned here rather than over an endpoint.
 */
import mongoose from 'mongoose';

export const MONGODB_URI =
  process.env.MONGODB_URI ??
  'mongodb://127.0.0.1:27018/tropis?replicaSet=rs0&directConnection=true';

const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export interface TenantInput {
  id: string;
  name: string;
  selfSignup: boolean;
  status?: 'active' | 'suspended';
}

export async function withDb<T>(fn: () => Promise<T>): Promise<T> {
  await mongoose.connect(MONGODB_URI);
  try {
    return await fn();
  } finally {
    await mongoose.disconnect();
  }
}

/**
 * Creates the tenant in the registry, or updates its name, status and self
 * sign-up flag. Same document shape as the backend's `tenants` collection.
 * Running processes see a change within a minute (their directory cache).
 */
export async function registerTenant(input: TenantInput): Promise<void> {
  if (!TENANT_ID.test(input.id)) {
    throw new Error(
      `Invalid tenant id ${JSON.stringify(input.id)} (1-128 of [A-Za-z0-9_.-])`,
    );
  }
  const now = new Date();
  await mongoose.connection.collection<{ _id: string }>('tenants').updateOne(
    { _id: input.id },
    {
      $set: {
        name: input.name,
        status: input.status ?? 'active',
        selfSignup: input.selfSignup,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
}

/**
 * Adds the admin role to the user with this email in the tenant. Returns
 * false when there is no such user.
 */
export async function grantAdmin(
  tenantId: string,
  email: string,
): Promise<'granted' | 'already' | 'missing'> {
  const users = mongoose.connection.collection('users');
  const existing = await users.findOne({ email, tenantId, deletedAt: null });
  if (!existing) return 'missing';
  if ((existing.roles as string[] | undefined)?.includes('admin')) {
    return 'already';
  }
  // $addToSet, not $set: $set would drop the roles the user already has.
  await users.updateOne(
    { _id: existing._id },
    { $addToSet: { roles: 'admin' } },
  );
  return 'granted';
}
