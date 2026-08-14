import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

export type EventLogDocument = HydratedDocument<EventLog>;

export enum AnalyticsEventType {
  PAGE_VIEW = 'page_view',
  BUTTON_CLICK = 'button_click',
  API_CALL = 'api_call',
  ERROR = 'error',
  PURCHASE = 'purchase',
}

@Schema({ timestamps: true, versionKey: false })
export class EventLog {
  @Prop({ required: true })
  eventId: string;

  @Prop({ required: true, enum: AnalyticsEventType, index: true })
  eventType: AnalyticsEventType;

  @Prop({ required: true, index: true })
  userId: string;

  @Prop({ type: Object, default: {} })
  metadata: Record<string, unknown>;

  @Prop({ required: true })
  timestamp: number;
}

export const EventLogSchema = SchemaFactory.createForClass(EventLog);
