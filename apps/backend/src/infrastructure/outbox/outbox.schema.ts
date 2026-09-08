import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type OutboxDocument = HydratedDocument<Outbox>;

export enum OutboxStatus {
  PENDING = 'pending',
  DISPATCHED = 'dispatched',
  FAILED = 'failed',
  /**
   * Terminal: retries are exhausted. A distinct state is what makes such rows
   * countable and alertable; left as FAILED they are neither requeued nor
   * surfaced, and the event is lost without anyone being told.
   */
  DEAD = 'dead',
}

// Append-only table written inside the same MongoDB transaction as the business write.
// A background relay reads PENDING rows and publishes them to Pulsar, then marks them DISPATCHED.
// If the relay crashes mid-flight, the row stays PENDING and is retried — guaranteeing at-least-once delivery.
@Schema({
  collection: 'outbox',
  timestamps: true,
  versionKey: false,
})
export class Outbox {
  @Prop({ required: true, index: true })
  aggregateId: string;

  @Prop({ required: true })
  eventType: string;

  @Prop({ required: true })
  topic: string;

  @Prop({ type: Object, default: {} })
  payload: Record<string, unknown>;

  @Prop({ enum: OutboxStatus, default: OutboxStatus.PENDING, index: true })
  status: OutboxStatus;

  @Prop({ default: 0 })
  attempts: number;

  @Prop({ type: Date, default: null })
  dispatchedAt: Date | null;

  @Prop({ type: String, default: null })
  lastError: string | null;

  /**
   * When this row becomes eligible for another attempt. Written by markFailed
   * with exponential backoff; requeueFailed compares it against the clock.
   *
   * It is an explicit field rather than an `updatedAt` arithmetic expression:
   * $add over a missing field yields null, and `$lte: [null, <date>]` is true
   * under BSON type ordering, so a backoff keyed on a timestamp that may be
   * absent silently requeues everything on every poll.
   */
  @Prop({ type: Date, default: null, index: true })
  nextAttemptAt: Date | null;
}

export const OutboxSchema = SchemaFactory.createForClass(Outbox);
OutboxSchema.index({ status: 1, createdAt: 1 }); // fast poll for PENDING rows in insertion order
OutboxSchema.index({ status: 1, attempts: 1, nextAttemptAt: 1 }); // requeueFailed: status=failed + attempts < N + due
