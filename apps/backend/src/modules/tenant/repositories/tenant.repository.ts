import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Tenant, TenantDocument } from '../schemas/tenant.schema';

@Injectable()
export class TenantRepository {
  constructor(
    @InjectModel(Tenant.name) private readonly model: Model<Tenant>,
  ) {}

  findById(id: string): Promise<TenantDocument | null> {
    return this.model.findById(id).exec();
  }

  upsert(tenant: Tenant): Promise<TenantDocument> {
    const { _id, ...fields } = tenant;
    return this.model
      .findOneAndUpdate(
        { _id },
        { $set: fields },
        { upsert: true, returnDocument: 'after', includeResultMetadata: false },
      )
      .orFail()
      .exec();
  }
}
