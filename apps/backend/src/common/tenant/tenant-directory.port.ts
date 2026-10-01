import { AppError } from '../errors/app-error';
import type { TenantId } from '../keyspace';

export const TENANT_DIRECTORY = Symbol('TENANT_DIRECTORY');

export const TENANT_STATUSES = ['active', 'suspended'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

/** One registered tenant. */
export interface TenantRecord {
  id: TenantId;
  name: string;
  status: TenantStatus;
  /** Whether anyone may create an account in this tenant without an admin. */
  selfSignup: boolean;
}

export interface RegisterTenantInput {
  id: TenantId;
  name: string;
  status?: TenantStatus;
  selfSignup?: boolean;
}

/**
 * The registry of provisioned tenants: the one source of truth for which
 * tenants exist, whether they are active and whether they accept self
 * sign-up. A tenant id that is not registered here cannot sign up, log in
 * or hold a verified token.
 */
export interface TenantDirectory {
  /** The tenant, or null when it is not registered. */
  find(id: TenantId): Promise<TenantRecord | null>;
  /** Creates the tenant or replaces its name, status and self sign-up flag. */
  register(input: RegisterTenantInput): Promise<TenantRecord>;
}

/** Throws TENANT_NOT_FOUND or TENANT_INACTIVE unless the tenant is active. */
export function assertTenantActive(
  record: TenantRecord | null,
): asserts record is TenantRecord {
  if (!record) throw new AppError('TENANT_NOT_FOUND');
  if (record.status !== 'active') throw new AppError('TENANT_INACTIVE');
}
