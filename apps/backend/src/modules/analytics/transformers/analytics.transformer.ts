import { EventLogDocument } from '../schemas/event-log.schema';
import { IEventLog } from '../interfaces/analytics.interface';

export class AnalyticsTransformer {
  static toResponse(doc: EventLogDocument): IEventLog {
    return {
      eventId: doc.eventId,
      eventType: doc.eventType,
      userId: doc.userId,
      metadata: doc.metadata,
      timestamp: doc.timestamp,
    };
  }
}
