import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';
import { ANALYTICS_EVENT_TYPES, type AnalyticsEventType } from '@tropis/shared';
import { tenantScopePlugin } from '../../../infrastructure/documents/tenant-scope';

export type EventLogDocument = HydratedDocument<EventLog>;

@Schema({ timestamps: true, versionKey: false })
export class EventLog {
  @Prop({ required: true, index: true })
  tenantId: string;

  @Prop({ required: true })
  eventId: string;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(ANALYTICS_EVENT_TYPES),
    index: true,
  })
  eventType: AnalyticsEventType;

  @Prop({ required: true, index: true })
  userId: string;

  @Prop({ type: Object, default: {} })
  metadata: Record<string, unknown>;

  // Indexed: event-log reads sort by timestamp descending. Sorting an
  // unindexed field forces an in-memory sort that hard-fails once the result
  // set passes MongoDB's 32MB sort limit.
  @Prop({ required: true, index: true })
  timestamp: number;
}

export const EventLogSchema = SchemaFactory.createForClass(EventLog);
EventLogSchema.plugin(tenantScopePlugin);
// Recent-events reads are always "this tenant, newest first".
EventLogSchema.index({ tenantId: 1, timestamp: -1 });
