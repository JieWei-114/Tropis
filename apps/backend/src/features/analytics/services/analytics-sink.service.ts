import { Inject, Injectable } from '@nestjs/common';
import type { TenantId } from '../../../common/keyspace';
import { createLogger } from '../../../common/observability/logger';
import {
  REALTIME,
  type RealtimePort,
} from '../../../infrastructure/realtime/realtime.port';
import { ANALYTICS_LIVE_FEED_ROLES } from '../constants/analytics.constants';
import type { IEventLog } from '../interfaces/analytics.interface';
import { AnalyticsRepository } from '../repositories/analytics.repository';

/** The OLAP write and live feed of one recorded analytics event. */
@Injectable()
export class AnalyticsSinkService {
  private readonly logger = createLogger('analytics');

  constructor(
    private readonly analyticsRepo: AnalyticsRepository,
    @Inject(REALTIME) private readonly realtime: RealtimePort,
  ) {}

  /** Throws when the OLAP store rejects the row, so the event is redelivered. */
  async store(tenantId: TenantId, event: IEventLog): Promise<void> {
    await this.analyticsRepo.insertEvent(tenantId, {
      event_id: event.eventId,
      event_type: event.eventType,
      user_id: event.userId,
      payload: JSON.stringify(event.metadata ?? {}),
      ts: event.timestamp,
    });
    this.logger.debug('event-written', 'Event written to OLAP', {
      'analytics.event_id': event.eventId,
      'analytics.event_type': event.eventType,
    });
  }

  /** Cosmetic live-feed push; never throws, so a stored event is not redelivered. */
  async publishLive(tenantId: TenantId, event: IEventLog): Promise<void> {
    await this.realtime
      .publishToRoles(
        tenantId,
        ANALYTICS_LIVE_FEED_ROLES,
        'analytics.event',
        event,
      )
      .catch((err: unknown) =>
        this.logger.warn(
          'live-push-failed',
          'Live-feed push failed; the event is stored',
          { 'analytics.event_id': event.eventId },
          err,
        ),
      );
  }
}
