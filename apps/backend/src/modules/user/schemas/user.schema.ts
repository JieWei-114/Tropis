import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

export type UserDocument = HydratedDocument<User>;

export enum UserStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

export enum UserRole {
  ADMIN = 'admin',
  EDITOR = 'editor',
  VIEWER = 'viewer',
}

/**
 * Soft delete pattern:
 *   deletedAt = null       → active, appears in all normal queries
 *   deletedAt = <Date>     → soft-deleted, filtered out by default
 *
 * Why soft delete instead of hard delete?
 *   - Data recovery: you can restore a deleted user without a backup
 *   - Audit trail: you know when and can log who deleted it
 *   - Foreign keys: other records (orders, events) still reference the user id
 *   - GDPR: "right to erasure" — separately handle PII scrubbing vs record deletion
 *
 * How it works here:
 *   UserRepository.delete() sets deletedAt = new Date() (soft delete)
 *   UserRepository.hardDelete() removes the document entirely
 *   All find queries filter { deletedAt: null } automatically
 */

export const DEFAULT_TENANT = 'default';

@Schema({ timestamps: true, versionKey: false })
export class User {
  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ required: true, lowercase: true, index: true })
  email: string;

  // select: false — never returned in queries unless explicitly requested with +passwordHash
  @Prop({ select: false })
  passwordHash: string;

  @Prop({ min: 0, max: 120 })
  age?: number;

  @Prop({ enum: UserStatus, default: UserStatus.ACTIVE })
  status: UserStatus;

  @Prop({ default: 0 })
  loginCount: number;

  @Prop({ type: [String], enum: UserRole, default: [UserRole.EDITOR] })
  roles: UserRole[];

  // Multi-tenancy — every record belongs to exactly one tenant.
  // Queries always filter by tenantId; users from different tenants are invisible to each other.
  // Default tenant ('default') is used for self-hosted / single-tenant deployments.
  @Prop({ required: true, index: true, default: DEFAULT_TENANT })
  tenantId: string;

  // OAuth provider fields — set when a user registers via Google/GitHub instead of password
  @Prop({ index: true, sparse: true })
  provider?: string; // 'google' | 'github'

  @Prop({ sparse: true })
  providerId?: string; // provider-side user ID

  // Soft delete — null means active, a date means deleted
  @Prop({ type: Date, default: null, index: true })
  deletedAt: Date | null;
}

export const UserSchema = SchemaFactory.createForClass(User);

// Compound unique index: email is unique per tenant, not globally.
// Two tenants can have the same email — they are separate accounts.
UserSchema.index({ email: 1, tenantId: 1 }, { unique: true });
// Fast lookup for OAuth login: find user by provider + providerId within a tenant
UserSchema.index({ provider: 1, providerId: 1, tenantId: 1 }, { sparse: true });
