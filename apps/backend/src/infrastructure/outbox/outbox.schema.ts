import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type OutboxDocument = HydratedDocument<Outbox>;

export enum OutboxStatus {
  PENDING = 'pending',
  DISPATCHED = 'dispatched',
  FAILED = 'failed',
}

// Append-only table written inside the same MongoDB transaction as the business write.
// A background relay reads PENDING rows and publishes them to Pulsar, then marks them DISPATCHED.
// If the relay crashes mid-flight, the row stays PENDING and is retried — guaranteeing at-least-once delivery.
@Schema({
  collection: 'outbox',
  timestamps: { createdAt: true, updatedAt: false },
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
}

export const OutboxSchema = SchemaFactory.createForClass(Outbox);
OutboxSchema.index({ status: 1, createdAt: 1 }); // fast poll for PENDING rows in insertion order
OutboxSchema.index({ status: 1, attempts: 1 }); // requeueFailed query: status=failed + attempts < N
