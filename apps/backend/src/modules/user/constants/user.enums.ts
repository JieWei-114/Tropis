/**
 * Domain enums for the user module.
 *
 * They live in constants/ rather than in the schema because they cross the API
 * boundary: controllers, DTOs and guards all need them, while the schema is a
 * persistence detail that must not leak past the service layer (see the
 * `controllers-not-into-schemas` rule in .dependency-cruiser.cjs). The schema
 * imports them from here, not the other way round.
 */

export enum UserStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

export enum UserRole {
  ADMIN = 'admin',
  EDITOR = 'editor',
  VIEWER = 'viewer',
}

/** Tenant assigned to records created without an explicit tenant. */
export const DEFAULT_TENANT = 'default';
