import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, ClientSession } from 'mongoose';
import { Outbox, OutboxDocument, OutboxStatus } from './outbox.schema';
import { USER_TOPIC } from '../../modules/user/constants/user.constants';

@Injectable()
export class OutboxService {
  constructor(
    @InjectModel(Outbox.name)
    private readonly outboxModel: Model<OutboxDocument>,
  ) {}

  // Call inside the same Mongoose session/transaction as your business write.
  // Both writes either commit together or roll back together — no lost events.
  // topic defaults to USER_TOPIC for backwards compatibility.
  async write(
    aggregateId: string,
    eventType: string,
    payload: Record<string, unknown>,
    session?: ClientSession,
    topic = USER_TOPIC,
  ): Promise<void> {
    await this.outboxModel.create(
      [{ aggregateId, eventType, topic, payload }],
      session ? { session } : {},
    );
  }

  async pendingBatch(limit = 50): Promise<OutboxDocument[]> {
    return this.outboxModel
      .find({ status: OutboxStatus.PENDING })
      .sort({ createdAt: 1 })
      .limit(limit)
      .exec();
  }

  async markDispatched(id: string): Promise<void> {
    await this.outboxModel.updateOne(
      { _id: id },
      { status: OutboxStatus.DISPATCHED, dispatchedAt: new Date() },
    );
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.outboxModel.updateOne(
      { _id: id },
      {
        $set: { status: OutboxStatus.FAILED, lastError: error },
        $inc: { attempts: 1 },
      },
    );
  }

  async requeueFailed(maxAttempts = 5): Promise<void> {
    await this.outboxModel.updateMany(
      { status: OutboxStatus.FAILED, attempts: { $lt: maxAttempts } },
      { status: OutboxStatus.PENDING },
    );
  }
}
