import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Counter } from 'prom-client';
import type { DedupKey, TenantId } from '../../../common/keyspace';
import { AppError, isAppError } from '../../../common/errors';
import {
  TENANT_DIRECTORY,
  assertTenantActive,
  type TenantDirectory,
} from '../../../common/tenant/tenant-directory.port';
import { createLogger } from '../../../common/observability/logger';
import {
  DEDUP,
  type DedupPort,
} from '../../../infrastructure/dedup/dedup.port';
import { MESSAGING } from '../../../infrastructure/messaging/messaging.port';
import type { MessagingPort } from '../../../infrastructure/messaging/messaging.port';
import { TrackingRepository } from '../repositories/tracking.repository';
import { TrackBatchDto } from '../dto/track-event.dto';
import {
  TRACKING_TOPIC,
  TRACKING_INSIGHTS_DEFAULT_DAYS,
  TRACKING_EVENT_SEEN,
  TRACKING_SEEN_TTL_SECONDS,
  TRACKING_CLAIM_TTL_SECONDS,
  TRACKING_BATCH_EVENT_TYPE,
  TRACKING_DUPLICATES_METRIC,
} from '../constants/tracking.constants';
import {
  ITrackingEvent,
  ITrackingInsights,
} from '../interfaces/tracking.interface';

/**
 * Ingest + read side of user-behavior tracking.
 *
 * DELIBERATE DEVIATION from the outbox rule in docs/tech-decisions.md:
 * tracking batches are published to the broker DIRECTLY, without the MongoDB
 * outbox. Behavioral events are high-volume and lossy-tolerant — losing a
 * batch during a broker hiccup costs nothing business-wise, while forcing
 * every beacon through a Mongo transaction would double the write load of
 * the hottest endpoint in the app. Domain events (user.created, …) still
 * MUST go through the outbox.
 */
@Injectable()
export class TrackingService {
  private readonly logger = createLogger('tracking');

  constructor(
    private readonly trackingRepo: TrackingRepository,
    @Inject(MESSAGING) private readonly broker: MessagingPort,
    @Inject(DEDUP) private readonly dedup: DedupPort,
    @Inject(TENANT_DIRECTORY) private readonly tenants: TenantDirectory,
    @InjectMetric(TRACKING_DUPLICATES_METRIC)
    private readonly duplicatesDropped: Counter<string>,
  ) {}

  /**
   * Ingest is accepted only for a registered, active tenant (directory
   * lookups are cached). A directory that cannot be read is
   * SERVICE_UNAVAILABLE, so a retrying tracker keeps its batch.
   */
  async assertAccepting(tenantId: TenantId): Promise<void> {
    let record;
    try {
      record = await this.tenants.find(tenantId);
    } catch (err) {
      if (isAppError(err)) throw err;
      throw new AppError('SERVICE_UNAVAILABLE', { cause: err });
    }
    assertTenantActive(record);
  }

  /**
   * Enrich the batch with the server receipt timestamp + tenant, then publish
   * it to the message broker. Fire-and-forget: failures are logged, never
   * surfaced — the controller has already answered 202. Each event id is
   * claimed briefly before the publish, the claim is extended once the
   * publish succeeded and released when it failed, so a failed batch can be
   * retried.
   */
  async ingest(tenantId: TenantId, dto: TrackBatchDto): Promise<void> {
    const receivedAt = Date.now();
    const owner = randomUUID();
    const { fresh, claimed } = await this.dropAlreadySeen(
      dto.events,
      tenantId,
      owner,
    );
    if (!fresh.length) return;

    const events: ITrackingEvent[] = fresh.map((e) => ({
      eventId: e.eventId,
      eventName: e.eventName,
      anonymousId: e.anonymousId,
      userId: e.userId,
      sessionId: e.sessionId,
      tenantId,
      page: e.page,
      referrer: e.referrer ?? '',
      userAgent: e.userAgent ?? '',
      screen: e.screen ?? '',
      props: e.props ?? {},
      timestamp: e.timestamp,
      receivedAt,
    }));

    try {
      await this.broker.publish(
        TRACKING_TOPIC,
        { events },
        { event: { tenantId, type: TRACKING_BATCH_EVENT_TYPE } },
      );
    } catch (err) {
      // Lossy-tolerant by design — drop the batch, keep the endpoint fast.
      this.logger.warn(
        'publish-failed',
        'Tracking publish failed; batch dropped',
        { 'tracking.events': events.length },
        err,
      );
      await this.settleClaims(() => this.dedup.releaseMany(claimed, owner));
      return;
    }
    await this.settleClaims(() =>
      this.dedup.extendMany(claimed, TRACKING_SEEN_TTL_SECONDS, owner),
    );
  }

  private async settleClaims(settle: () => Promise<unknown>): Promise<void> {
    try {
      await settle();
    } catch (err) {
      this.logger.warn(
        'dedup-settle-failed',
        'Tracking dedup claims could not be settled',
        {},
        err,
      );
    }
  }

  /**
   * Claims each event's `eventId` for this ingest (`owner`) and returns only
   * the ones not seen before, with the keys this call claimed.
   *
   * The claim is per tenant and atomic, so two concurrent batches carrying
   * the same event cannot both win. A dedup store that cannot answer
   * accepts the batch: over-counting on a retry is far less bad than
   * dropping real traffic, and the endpoint must stay up regardless.
   */
  private async dropAlreadySeen<T extends { eventId: string }>(
    events: T[],
    tenantId: TenantId,
    owner: string,
  ): Promise<{ fresh: T[]; claimed: DedupKey[] }> {
    const keys = events.map((e) =>
      TRACKING_EVENT_SEEN.forTenant(tenantId, e.eventId),
    );
    let claims: boolean[];
    try {
      claims = await this.dedup.claimMany(
        keys,
        TRACKING_CLAIM_TTL_SECONDS,
        owner,
      );
    } catch (err) {
      this.logger.warn(
        'dedup-unavailable',
        'Tracking dedup unavailable; accepting the batch as-is',
        {},
        err,
      );
      return { fresh: events, claimed: [] };
    }
    const fresh = events.filter((_, i) => claims[i]);
    const claimed = keys.filter((_, i) => claims[i]);
    const dropped = events.length - fresh.length;
    if (dropped > 0) {
      // Counted as well as logged: the debug log is invisible in production,
      // and a sudden spike means a client is retrying beacons.
      this.duplicatesDropped.inc(dropped);
      this.logger.debug(
        'duplicates-dropped',
        'Duplicate tracking events dropped',
        { 'tracking.events_dropped': dropped },
      );
    }
    return { fresh, claimed };
  }

  /** Dashboard aggregates, straight from OLAP (no cache — cheap queries). */
  async getInsights(
    tenantId: TenantId,
    days = TRACKING_INSIGHTS_DEFAULT_DAYS,
  ): Promise<ITrackingInsights> {
    const window = days > 0 ? days : TRACKING_INSIGHTS_DEFAULT_DAYS;
    const [topPages, eventsByName, dailyUniques, recent, funnel] =
      await Promise.all([
        this.trackingRepo.getTopPages(window, tenantId),
        this.trackingRepo.getEventsByName(window, tenantId),
        this.trackingRepo.getDailyUniques(window, tenantId),
        this.trackingRepo.getRecent(tenantId),
        this.trackingRepo.getFunnel(window, tenantId),
      ]);
    return { topPages, eventsByName, dailyUniques, recent, funnel };
  }
}
