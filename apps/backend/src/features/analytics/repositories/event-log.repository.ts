import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { TenantId } from '../../../common/keyspace';
import type { DocumentsTransaction } from '../../../infrastructure/documents/documents.port';
import { TenantScopedRepository } from '../../../infrastructure/documents/tenant-scope';
import { EventLog, EventLogDocument } from '../schemas/event-log.schema';

@Injectable()
export class EventLogRepository extends TenantScopedRepository<EventLog> {
  constructor(@InjectModel(EventLog.name) model: Model<EventLog>) {
    super(model);
  }

  create(
    tenantId: TenantId,
    data: Partial<EventLog>,
    tx?: DocumentsTransaction,
  ): Promise<EventLogDocument> {
    return this.insert(tenantId, data, tx);
  }

  /** Newest events of one tenant. */
  findAll(tenantId: TenantId, limit = 50): Promise<EventLogDocument[]> {
    return this.find(tenantId).sort({ timestamp: -1 }).limit(limit).exec();
  }

  countAll(tenantId: TenantId): Promise<number> {
    return this.countDocuments(tenantId).exec();
  }
}
