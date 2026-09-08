import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';
import { AnalyticsEventType } from '../constants/analytics.enums';
import { DEFAULT_TENANT } from '../../user/constants/user.enums';

// Re-exported so existing schema-path imports keep working.
export { AnalyticsEventType };

export type EventLogDocument = HydratedDocument<EventLog>;

@Schema({ timestamps: true, versionKey: false })
export class EventLog {
  /**
   * Owning tenant. Without it getRecent() could not scope the live feed and
   * every tenant saw every other tenant's events.
   */
  @Prop({ required: true, index: true, default: DEFAULT_TENANT })
  tenantId: string;

  @Prop({ required: true })
  eventId: string;

  @Prop({
    type: String,
    required: true,
    enum: AnalyticsEventType,
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
// Recent-events reads are always "this tenant, newest first".
EventLogSchema.index({ tenantId: 1, timestamp: -1 });
