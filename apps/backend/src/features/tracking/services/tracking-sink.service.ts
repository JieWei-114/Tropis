import { Inject, Injectable } from '@nestjs/common';
import type { TenantId } from '../../../common/keyspace';
import { createLogger } from '../../../common/observability/logger';
import {
  REALTIME,
  type RealtimePort,
} from '../../../infrastructure/realtime/realtime.port';
import type { ITrackingEvent } from '../interfaces/tracking.interface';
import { TrackingRepository } from '../repositories/tracking.repository';

/** The OLAP write and live nudge of a consumed tracking batch. */
@Injectable()
export class TrackingSinkService {
  private readonly logger = createLogger('tracking');

  constructor(
    private readonly trackingRepo: TrackingRepository,
    @Inject(REALTIME) private readonly realtime: RealtimePort,
  ) {}

  /** Throws when the OLAP store rejects the batch, so it is redelivered. */
  async store(tenantId: TenantId, events: ITrackingEvent[]): Promise<void> {
    await this.trackingRepo.insertEvents(
      tenantId,
      events.map((e) => ({
        event_id: e.eventId,
        event_name: e.eventName,
        anonymous_id: e.anonymousId,
        user_id: e.userId ?? '',
        session_id: e.sessionId,
        page: e.page,
        referrer: e.referrer,
        user_agent: e.userAgent,
        screen: e.screen,
        props: JSON.stringify(e.props ?? {}),
        timestamp: e.timestamp,
      })),
    );
    this.logger.debug('batch-written', 'Tracking batch written', {
      'tracking.events': events.length,
    });
  }

  /**
   * Nudges connected dashboards that fresh behavior data landed. Never
   * throws: a failed push must not redeliver a written batch.
   */
  async notify(tenantId: TenantId, count: number): Promise<void> {
    await this.realtime
      .publishToTenant(tenantId, 'tracking.event', { count, at: Date.now() })
      .catch((err: unknown) =>
        this.logger.warn(
          'live-push-failed',
          'Tracking live push failed',
          {},
          err,
        ),
      );
  }
}
