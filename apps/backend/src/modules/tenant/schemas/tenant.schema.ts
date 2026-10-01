import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';
import {
  TENANT_STATUSES,
  type TenantStatus,
} from '../../../common/tenant/tenant-directory.port';

export type TenantDocument = HydratedDocument<Tenant>;

/**
 * The tenant registry. Not tenant-scoped: each document IS a tenant, keyed
 * by its id.
 */
@Schema({ collection: 'tenants', timestamps: true, versionKey: false })
export class Tenant {
  @Prop({ type: String, required: true })
  _id: string;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ type: String, enum: TENANT_STATUSES, default: 'active' })
  status: TenantStatus;

  @Prop({ default: false })
  selfSignup: boolean;
}

export const TenantSchema = SchemaFactory.createForClass(Tenant);
