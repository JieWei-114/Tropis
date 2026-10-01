import { randomUUID } from 'crypto';
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { DEFAULT_EVENT_SCHEMA_VERSION } from '@tropis/shared';
import { injectTraceContext } from '../../common/observability/propagation';
import type { DocumentsTransaction } from '../documents/documents.port';
import { sessionOf } from '../documents/transaction';
import {
  OPEN_STATUSES,
  Outbox,
  OutboxDocument,
  OutboxHead,
  OutboxHeadDocument,
  OutboxStatus,
  type OutboxEvent,
} from './outbox.schema';
import {
  DEFAULT_OUTBOX_RETENTION_DAYS,
  MAX_ATTEMPTS,
  RETRY_BACKOFF_BASE_MS,
} from './outbox.constants';

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a caller enqueues: one event, published to `topic` after commit. */
export interface OutboxEventInput {
  topic: string;
  /** Events of one aggregate are published in the order they were written. */
  aggregateId: string;
  /** `<domain>.<entity>.<past-tense>` (or the registry name in @tropis/shared). */
  type: string;
  tenantId: string;
  /** The event's `data`, published as the message body. */
  data: Record<string, unknown>;
  /** Defaults to aggregateId. */
  subject?: string;
  /** Defaults to a new UUID; pass a domain id to make it the event id. */
  id?: string;
  schemaVersion?: string;
}

/** Row selector for the operator actions. */
export type OutboxRowFilter = { id: string } | { aggregateId: string };

/**
 * The outbox table and its per-aggregate heads (outbox.schema.ts). Rows
 * that reach a terminal state are kept for OUTBOX_RETENTION_DAYS (TTL on
 * `expireAt`), then deleted by MongoDB.
 */
@Injectable()
export class OutboxService {
  private readonly retentionMs: number;

  constructor(
    @InjectModel(Outbox.name)
    private readonly outboxModel: Model<OutboxDocument>,
    @InjectModel(OutboxHead.name)
    private readonly headModel: Model<OutboxHeadDocument>,
    @Optional() config?: ConfigService,
  ) {
    const days = Number(
      config?.get<number>(
        'OUTBOX_RETENTION_DAYS',
        DEFAULT_OUTBOX_RETENTION_DAYS,
      ) ?? DEFAULT_OUTBOX_RETENTION_DAYS,
    );
    this.retentionMs = days * DAY_MS;
  }

  private expiry(from = Date.now()): Date {
    return new Date(from + this.retentionMs);
  }

  /**
   * Call inside the business write's DocumentsPort.withTransaction, with its
   * `tx`: both commit or roll back together, so no event is lost or invented. The
   * event attributes, including the caller's trace context, are fixed here.
   * Returns the event id.
   */
  async write(
    input: OutboxEventInput,
    tx?: DocumentsTransaction,
  ): Promise<string> {
    const session = sessionOf(tx);
    const carrier = injectTraceContext({});
    const event: OutboxEvent = {
      id: input.id ?? randomUUID(),
      type: input.type,
      subject: input.subject ?? input.aggregateId,
      tenantId: input.tenantId,
      time: new Date(),
      schemaVersion: input.schemaVersion ?? DEFAULT_EVENT_SCHEMA_VERSION,
    };
    if (carrier.traceparent) event.traceparent = carrier.traceparent;
    if (carrier.tracestate) event.tracestate = carrier.tracestate;
    // The head first: a relay that retires the head after this write cannot
    // match its version, so the row is never left without one.
    await this.headModel.updateOne(
      { _id: input.aggregateId },
      { $setOnInsert: { dueAt: event.time }, $inc: { v: 1 } },
      { upsert: true, ...(session ? { session } : {}) },
    );
    await this.outboxModel.create(
      [
        {
          aggregateId: input.aggregateId,
          topic: input.topic,
          payload: input.data,
          event,
        },
      ],
      session ? { session } : {},
    );
    return event.id;
  }

  /**
   * Aggregates whose head row is due, longest-waiting first: read from the
   * heads by `dueAt` (an index range), never from the row backlog.
   *
   * An aggregate is due when its head row is PENDING, or FAILED with its
   * backoff elapsed. A DEAD head blocks the aggregate until an operator
   * redrives or skips it; a FAILED head that is not yet due blocks it until
   * then. Selecting on the head row is what keeps per-aggregate order: none
   * of an aggregate's later events can leave while an earlier one waits.
   */
  async dueAggregates(limit: number, now = new Date()): Promise<string[]> {
    const heads = await this.headModel
      .find({ dueAt: { $lte: now } }, { _id: 1 })
      .sort({ dueAt: 1 })
      .limit(limit)
      .lean()
      .exec();
    return heads.map((h) => h._id);
  }

  /**
   * Re-derives an aggregate's head from its rows, after the relay worked on
   * it (the caller holds its lease): retired when no row is open and none
   * was written since, otherwise due when its head row is.
   */
  async settleHead(aggregateId: string): Promise<void> {
    const head = await this.headModel.findById(aggregateId).lean().exec();
    const row = await this.headOf(aggregateId);
    if (!row) {
      if (head) {
        await this.headModel.deleteOne({ _id: aggregateId, v: head.v });
      }
      return;
    }
    await this.headModel.updateOne(
      { _id: aggregateId },
      { $set: { dueAt: dueAtOf(row) } },
      { upsert: true },
    );
  }

  /**
   * Repairs the heads from the rows: every aggregate with a PENDING or
   * FAILED row gets a head (rows written before heads existed, a head lost
   * to a crash), and a head that is not due is re-derived from its rows
   * (rows changed by hand). Terminal rows without an expiry (written before
   * retention existed) get one, so the TTL index removes them too. Run by
   * the sweep, once a minute.
   */
  async repairHeads(now = new Date()): Promise<number> {
    await this.outboxModel
      .updateMany(
        {
          status: { $in: [OutboxStatus.DISPATCHED, OutboxStatus.SKIPPED] },
          expireAt: null,
        },
        { $set: { expireAt: this.expiry(now.getTime()) } },
      )
      .exec();
    const open: string[] = await this.outboxModel
      .distinct('aggregateId', {
        status: { $in: [OutboxStatus.PENDING, OutboxStatus.FAILED] },
      })
      .exec();
    let repaired = 0;
    if (open.length) {
      const res = await this.headModel.bulkWrite(
        open.map((id) => ({
          updateOne: {
            filter: { _id: id },
            update: { $setOnInsert: { dueAt: now, v: 0 } },
            upsert: true,
          },
        })),
        { ordered: false },
      );
      repaired += res.upsertedCount ?? 0;
    }
    const waiting = await this.headModel
      .find({ $or: [{ dueAt: null }, { dueAt: { $gt: now } }] }, { _id: 1 })
      .lean()
      .exec();
    for (const { _id } of waiting) {
      const row = await this.headOf(_id);
      const dueAt = row ? dueAtOf(row) : now;
      if (dueAt && dueAt.getTime() <= now.getTime()) {
        await this.headModel.updateOne({ _id }, { $set: { dueAt } });
        repaired += 1;
      }
    }
    return repaired;
  }

  /** Puts the heads of these aggregates in line now (after an operator action). */
  private async requeue(aggregateIds: readonly string[]): Promise<void> {
    if (!aggregateIds.length) return;
    const now = new Date();
    await this.headModel.bulkWrite(
      aggregateIds.map((id) => ({
        updateOne: {
          filter: { _id: id },
          update: { $set: { dueAt: now }, $inc: { v: 1 } },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  /** The aggregate's oldest open row, read fresh (the caller holds its lease). */
  headOf(aggregateId: string): Promise<OutboxDocument | null> {
    return this.outboxModel
      .findOne({ aggregateId, status: { $in: OPEN_STATUSES } })
      .sort({ createdAt: 1, _id: 1 })
      .exec();
  }

  async markDispatched(id: string): Promise<void> {
    await this.outboxModel.updateOne(
      {
        _id: id,
        status: { $in: [OutboxStatus.PENDING, OutboxStatus.FAILED] },
      },
      {
        $set: {
          status: OutboxStatus.DISPATCHED,
          dispatchedAt: new Date(),
          nextAttemptAt: null,
          expireAt: this.expiry(),
        },
      },
    );
  }

  /**
   * Records a failed publish: FAILED with exponential backoff, or DEAD once
   * `maxAttempts` attempts have failed. Returns the status written, or null
   * when the row had already left PENDING/FAILED (another instance published
   * it), which is then left as it is.
   */
  async markFailed(
    row: Pick<OutboxDocument, '_id' | 'attempts'>,
    error: string,
    maxAttempts = MAX_ATTEMPTS,
  ): Promise<OutboxStatus.FAILED | OutboxStatus.DEAD | null> {
    const attempts = (row.attempts ?? 0) + 1;
    const dead = attempts >= maxAttempts;
    const delayMs = RETRY_BACKOFF_BASE_MS * Math.pow(2, attempts - 1);
    const res = await this.outboxModel.updateOne(
      {
        _id: row._id,
        status: { $in: [OutboxStatus.PENDING, OutboxStatus.FAILED] },
      },
      {
        $set: {
          status: dead ? OutboxStatus.DEAD : OutboxStatus.FAILED,
          attempts,
          lastError: error,
          nextAttemptAt: dead ? null : new Date(Date.now() + delayMs),
        },
      },
    );
    if (res.matchedCount === 0) return null;
    return dead ? OutboxStatus.DEAD : OutboxStatus.FAILED;
  }

  /**
   * Moves FAILED rows at or past the retry ceiling to DEAD. markFailed does
   * this itself; the sweep catches rows that reached the ceiling under a
   * different limit.
   */
  async deadLetterExhausted(maxAttempts = MAX_ATTEMPTS): Promise<number> {
    const res = await this.outboxModel.updateMany(
      { status: OutboxStatus.FAILED, attempts: { $gte: maxAttempts } },
      { $set: { status: OutboxStatus.DEAD, nextAttemptAt: null } },
    );
    return res.modifiedCount ?? 0;
  }

  /** DEAD rows, oldest first, for an operator to inspect. */
  listDead(limit = 50): Promise<OutboxDocument[]> {
    return this.outboxModel
      .find({ status: OutboxStatus.DEAD })
      .sort({ createdAt: 1, _id: 1 })
      .limit(limit)
      .exec();
  }

  /**
   * Operator action: puts DEAD rows (one row, or every DEAD row of an
   * aggregate) back to PENDING with a fresh attempt budget. Use it once the
   * cause is fixed. Returns how many rows were redriven.
   */
  async redrive(filter: OutboxRowFilter): Promise<number> {
    const selector = { ...this.selector(filter), status: OutboxStatus.DEAD };
    const aggregates = await this.aggregatesOf(selector);
    const res = await this.outboxModel.updateMany(selector, {
      $set: {
        status: OutboxStatus.PENDING,
        attempts: 0,
        nextAttemptAt: null,
      },
    });
    await this.requeue(aggregates);
    return res.modifiedCount ?? 0;
  }

  /**
   * Operator action: gives up DEAD rows (one row, or every DEAD row of an
   * aggregate) so the aggregate's later events can flow. The event is never
   * published; consumers must tolerate the gap. Returns how many were skipped.
   */
  async skip(filter: OutboxRowFilter): Promise<number> {
    const selector = { ...this.selector(filter), status: OutboxStatus.DEAD };
    const aggregates = await this.aggregatesOf(selector);
    const now = Date.now();
    const res = await this.outboxModel.updateMany(selector, {
      $set: {
        status: OutboxStatus.SKIPPED,
        skippedAt: new Date(now),
        expireAt: this.expiry(now),
      },
    });
    await this.requeue(aggregates);
    return res.modifiedCount ?? 0;
  }

  private async aggregatesOf(
    selector: Record<string, unknown>,
  ): Promise<string[]> {
    return this.outboxModel.distinct('aggregateId', selector).exec();
  }

  /** Current DEAD backlog — exposed so it can be logged/alerted on. */
  countDead(): Promise<number> {
    return this.outboxModel.countDocuments({ status: OutboxStatus.DEAD });
  }

  /**
   * Backlog per status in a single grouped query, so the relay can publish it
   * as a gauge without adding one countDocuments call per status.
   *
   * DISPATCHED and SKIPPED are excluded on purpose: they are terminal history
   * and grow without bound. Statuses with no rows come back as 0 rather than
   * missing, otherwise a cleared backlog would leave the gauge pinned at its
   * last non-zero value.
   */
  async backlogByStatus(): Promise<Record<string, number>> {
    const rows = await this.outboxModel
      .aggregate<{
        _id: OutboxStatus;
        count: number;
      }>([
        { $match: { status: { $in: OPEN_STATUSES } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
      .exec();

    const counts = Object.fromEntries(
      OPEN_STATUSES.map((status) => [status, 0]),
    );
    for (const row of rows) counts[row._id] = row.count;
    return counts;
  }

  private selector(filter: OutboxRowFilter): Record<string, unknown> {
    if ('id' in filter) {
      if (!Types.ObjectId.isValid(filter.id)) {
        throw new Error(`Invalid outbox row id ${JSON.stringify(filter.id)}`);
      }
      return { _id: new Types.ObjectId(filter.id) };
    }
    return { aggregateId: filter.aggregateId };
  }
}

/** When a head row is next due; null while it is DEAD (blocked). */
function dueAtOf(row: Pick<OutboxDocument, 'status' | 'nextAttemptAt'>) {
  if (row.status === OutboxStatus.PENDING) return new Date();
  if (row.status === OutboxStatus.FAILED) {
    return row.nextAttemptAt ?? new Date();
  }
  return null;
}
