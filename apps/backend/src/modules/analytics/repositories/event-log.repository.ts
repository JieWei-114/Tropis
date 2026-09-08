import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { EventLog, EventLogDocument } from '../schemas/event-log.schema';
import { DEFAULT_TENANT } from '../../user/constants/user.enums';

@Injectable()
export class EventLogRepository {
  constructor(
    @InjectModel(EventLog.name) private readonly model: Model<EventLog>,
  ) {}

  create(data: Partial<EventLog>): Promise<EventLogDocument> {
    return this.model.create(data);
  }

  async createWithSession(
    data: Partial<EventLog>,
    session: ClientSession,
  ): Promise<EventLogDocument> {
    const [doc] = await this.model.create([data], { session });
    return doc;
  }

  /** Newest events for one tenant. The tenant filter is not optional. */
  findAll(limit = 50, tenantId = DEFAULT_TENANT): Promise<EventLogDocument[]> {
    return this.model
      .find({ tenantId })
      .sort({ timestamp: -1 })
      .limit(limit)
      .exec();
  }

  countAll(tenantId = DEFAULT_TENANT): Promise<number> {
    return this.model.countDocuments({ tenantId }).exec();
  }
}
