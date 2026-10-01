import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type OutboxDocument = HydratedDocument<Outbox>;

export enum OutboxStatus {
  PENDING = 'pending',
  DISPATCHED = 'dispatched',
  /** Waiting out its backoff; due again at `nextAttemptAt`. */
  FAILED = 'failed',
  /**
   * Terminal until an operator acts: retries are exhausted. The row blocks
   * its aggregate, because publishing the aggregate's later events past it
   * would deliver them out of order. OutboxService.redrive() puts it back to
   * PENDING; skip() moves it to SKIPPED and releases the aggregate.
   */
  DEAD = 'dead',
  /** Terminal: an operator gave the event up; never published. */
  SKIPPED = 'skipped',
}

/** Statuses that still hold their aggregate's place in line. */
export const OPEN_STATUSES = [
  OutboxStatus.PENDING,
  OutboxStatus.FAILED,
  OutboxStatus.DEAD,
];

/**
 * CloudEvents attributes of the row's event, fixed when the row is written
 * so every publish attempt of it carries the same id, time and trace.
 */
@Schema({ _id: false, versionKey: false })
export class OutboxEvent {
  /** Stable across publish attempts, so consumers can dedup on it. */
  @Prop({ required: true })
  id: string;

  /** `<domain>.<entity>.<past-tense>`. */
  @Prop({ required: true })
  type: string;

  @Prop({ type: String })
  subject?: string;

  @Prop({ required: true })
  tenantId: string;

  @Prop({ type: Date, required: true })
  time: Date;

  /** W3C trace context of the request that wrote the row. */
  @Prop({ type: String })
  traceparent?: string;

  @Prop({ type: String })
  tracestate?: string;

  @Prop({ required: true, default: '1' })
  schemaVersion: string;
}

export const OutboxEventSchema = SchemaFactory.createForClass(OutboxEvent);

// Append-only table written inside the same MongoDB transaction as the business write.
// The relay publishes each aggregate's open rows in insertion order, then marks them DISPATCHED.
// If the relay crashes mid-flight, the row stays open and is retried — guaranteeing at-least-once delivery.
@Schema({
  collection: 'outbox',
  timestamps: true,
  versionKey: false,
})
export class Outbox {
  @Prop({ required: true })
  aggregateId: string;

  @Prop({ required: true })
  topic: string;

  /** The event's `data`: the message body on the wire. */
  @Prop({ type: Object, default: {} })
  payload: Record<string, unknown>;

  @Prop({ type: OutboxEventSchema, required: true })
  event: OutboxEvent;

  @Prop({ enum: OutboxStatus, default: OutboxStatus.PENDING, index: true })
  status: OutboxStatus;

  @Prop({ default: 0 })
  attempts: number;

  @Prop({ type: Date, default: null })
  dispatchedAt: Date | null;

  @Prop({ type: String, default: null })
  lastError: string | null;

  /**
   * When a FAILED row becomes due again. Written by markFailed with
   * exponential backoff. A FAILED row without it is due now.
   *
   * It is an explicit field rather than an `updatedAt` arithmetic expression:
   * $add over a missing field yields null, and `$lte: [null, <date>]` is true
   * under BSON type ordering, so a backoff keyed on a timestamp that may be
   * absent silently retries everything on every poll.
   */
  @Prop({ type: Date, default: null })
  nextAttemptAt: Date | null;

  @Prop({ type: Date, default: null })
  skippedAt: Date | null;

  /**
   * When a terminal row (DISPATCHED or SKIPPED) is deleted: set to the
   * terminal time plus OUTBOX_RETENTION_DAYS; null while the row is open.
   */
  @Prop({ type: Date, default: null })
  expireAt: Date | null;

  createdAt?: Date;
}

export const OutboxSchema = SchemaFactory.createForClass(Outbox);
OutboxSchema.index({ status: 1, aggregateId: 1 }); // repairHeads: aggregates with open rows; operator filters
OutboxSchema.index({ aggregateId: 1, createdAt: 1, _id: 1 }); // headOf: an aggregate's rows in insertion order
OutboxSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 }); // retention of terminal rows

/**
 * One document per aggregate with open rows: when its head row is next due
 * (null while a DEAD head blocks it). The relay's candidate query reads
 * these by `dueAt`, so a poll never scans or sorts the row backlog. `v`
 * changes on every write, so the relay retires a head only if no row was
 * written since it looked.
 */
@Schema({ collection: 'outbox_heads', versionKey: false })
export class OutboxHead {
  /** The aggregate id. */
  @Prop({ type: String, required: true })
  _id: string;

  @Prop({ type: Date, default: null })
  dueAt: Date | null;

  @Prop({ type: Number, default: 0 })
  v: number;
}

export type OutboxHeadDocument = HydratedDocument<OutboxHead>;
export const OutboxHeadSchema = SchemaFactory.createForClass(OutboxHead);
OutboxHeadSchema.index({ dueAt: 1 }); // dueAggregates
