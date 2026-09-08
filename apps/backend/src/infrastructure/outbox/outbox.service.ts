import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, ClientSession } from 'mongoose';
import { Outbox, OutboxDocument, OutboxStatus } from './outbox.schema';
import { USER_TOPIC } from '../../modules/user/constants/user.constants';

/** Base for the exponential retry backoff: base * 2^attempts. */
const RETRY_BACKOFF_BASE_MS = 5_000;

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

  /**
   * PENDING rows in insertion order, excluding every aggregate that currently
   * has a FAILED or DEAD row.
   *
   * Per-aggregate ordering has to be enforced here, where the rows are
   * selected: a filter applied only within one relay batch lets the next poll
   * five seconds later publish an aggregate's later events while an earlier one
   * is still waiting out its backoff. Publishing UserUpdated after a failed
   * UserDeleted resurrects the user in Elasticsearch and pgvector.
   */
  async pendingBatch(limit = 50): Promise<OutboxDocument[]> {
    const stuck = await this.outboxModel.distinct('aggregateId', {
      status: { $in: [OutboxStatus.FAILED, OutboxStatus.DEAD] },
    });

    return this.outboxModel
      .find({
        status: OutboxStatus.PENDING,
        ...(stuck.length ? { aggregateId: { $nin: stuck } } : {}),
      })
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

  /**
   * Marks a row FAILED and schedules its next attempt with exponential backoff.
   *
   * The delay is computed here, from the attempt count this failure produces,
   * and stored — not derived in the requeue query. See the nextAttemptAt
   * docblock in outbox.schema.ts.
   */
  async markFailed(id: string, error: string): Promise<void> {
    const row = await this.outboxModel
      .findOne({ _id: id })
      .select('attempts')
      .lean()
      .exec();
    const attempts = (row?.attempts ?? 0) + 1;
    const delayMs = RETRY_BACKOFF_BASE_MS * Math.pow(2, attempts - 1);
    await this.outboxModel.updateOne(
      { _id: id },
      {
        $set: {
          status: OutboxStatus.FAILED,
          lastError: error,
          nextAttemptAt: new Date(Date.now() + delayMs),
        },
        $inc: { attempts: 1 },
      },
    );
  }

  /**
   * Requeues FAILED rows that are due for another attempt, with exponential
   * backoff (base * 2^attempts). The `nextAttemptAt` check is what bounds the
   * retry rate: without it a permanently failing topic is retried at full rate
   * on every poll.
   *
   * Returns how many rows were requeued.
   */
  async requeueFailed(maxAttempts = 5): Promise<number> {
    const res = await this.outboxModel.updateMany(
      {
        status: OutboxStatus.FAILED,
        attempts: { $lt: maxAttempts },
        nextAttemptAt: { $lte: new Date() },
      },
      { $set: { status: OutboxStatus.PENDING, nextAttemptAt: null } },
    );
    return res.modifiedCount ?? 0;
  }

  /**
   * Moves rows past the retry ceiling to the terminal DEAD state so they stop
   * being invisible. Returns the count so the caller can alert on it.
   */
  async deadLetterExhausted(maxAttempts = 5): Promise<number> {
    const res = await this.outboxModel.updateMany(
      { status: OutboxStatus.FAILED, attempts: { $gte: maxAttempts } },
      { $set: { status: OutboxStatus.DEAD } },
    );
    return res.modifiedCount ?? 0;
  }

  /** Current DEAD backlog — exposed so it can be logged/alerted on. */
  countDead(): Promise<number> {
    return this.outboxModel.countDocuments({ status: OutboxStatus.DEAD });
  }

  /**
   * Backlog per status in a single grouped query, so the relay can publish it
   * as a gauge without adding one countDocuments call per status.
   *
   * DISPATCHED is excluded on purpose: it is the append-only success history
   * and grows without bound, and its size says nothing about reliability.
   * Statuses with no rows come back as 0 rather than missing, otherwise a
   * cleared backlog would leave the gauge pinned at its last non-zero value.
   */
  async backlogByStatus(): Promise<Record<string, number>> {
    const tracked = [
      OutboxStatus.PENDING,
      OutboxStatus.FAILED,
      OutboxStatus.DEAD,
    ];
    const rows = await this.outboxModel
      .aggregate<{
        _id: OutboxStatus;
        count: number;
      }>([
        { $match: { status: { $in: tracked } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
      .exec();

    const counts = Object.fromEntries(tracked.map((status) => [status, 0]));
    for (const row of rows) counts[row._id] = row.count;
    return counts;
  }
}
