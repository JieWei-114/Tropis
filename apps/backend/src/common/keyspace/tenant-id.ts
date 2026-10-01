declare const tenantIdBrand: unique symbol;

/**
 * A validated tenant identifier. Branded so a request-supplied string cannot
 * reach a tenant-scoped API (keys, graph queries) without passing through
 * toTenantId() first.
 */
export type TenantId = string & { readonly [tenantIdBrand]: 'TenantId' };

const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export class InvalidTenantIdError extends Error {
  constructor(raw: unknown) {
    super(
      `Invalid tenant id ${JSON.stringify(raw)}: expected 1-128 chars of [A-Za-z0-9_.-] starting with a letter or digit`,
    );
    this.name = 'InvalidTenantIdError';
  }
}

export function isTenantId(raw: unknown): raw is TenantId {
  return typeof raw === 'string' && TENANT_ID_PATTERN.test(raw);
}

/** Validates and brands a raw tenant id; throws InvalidTenantIdError. */
export function toTenantId(raw: string): TenantId {
  if (!isTenantId(raw)) throw new InvalidTenantIdError(raw);
  return raw;
}
