import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { EventLog, EventLogDocument } from '../schemas/event-log.schema';

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

  findAll(limit = 50): Promise<EventLogDocument[]> {
    return this.model.find().sort({ timestamp: -1 }).limit(limit).exec();
  }

  countAll(): Promise<number> {
    return this.model.countDocuments().exec();
  }
}
