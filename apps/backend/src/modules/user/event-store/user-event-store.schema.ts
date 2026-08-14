import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

export type UserEventDocument = HydratedDocument<UserEvent>;

// Immutable append-only log — never update or delete rows here.
// Each row represents one thing that happened to a user aggregate.
// Replay all rows for an aggregateId in version order to rebuild current state.
@Schema({
  collection: 'user_event_store',
  timestamps: false,
  versionKey: false,
})
export class UserEvent {
  @Prop({ required: true, index: true })
  aggregateId: string;

  @Prop({ required: true })
  type: string; // 'UserCreated' | 'UserUpdated' | 'UserDeleted'

  @Prop({ type: Object, default: {} })
  payload: Record<string, unknown>;

  @Prop({ required: true })
  version: number; // monotonically increasing per aggregateId

  // Payload schema version — bump when the shape of `payload` changes.
  // Replay logic uses this to apply the correct migration transform before applying the event.
  @Prop({ required: true, default: 1 })
  schemaVersion: number;

  @Prop({ default: () => new Date() })
  occurredAt: Date;
}

export const UserEventSchema = SchemaFactory.createForClass(UserEvent);

// Compound index for fast replay: all events for an aggregate, in order
UserEventSchema.index({ aggregateId: 1, version: 1 }, { unique: true });
