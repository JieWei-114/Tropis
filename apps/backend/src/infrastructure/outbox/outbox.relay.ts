import {
  Injectable,
  Inject,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Gauge } from 'prom-client';
import { counter } from '../../common/observability/metrics';
import { createLogger } from '../../common/observability/logger';
import { CapabilityDisabledError } from '../capability';
import { runInExtractedContext } from '../../common/observability/propagation';
import { OutboxService } from './outbox.service';
import { MESSAGING } from '../messaging/messaging.port';
import type {
  EventAttributes,
  MessagingPort,
} from '../messaging/messaging.port';
import { LOCK, type Lease, type LockPort } from '../lock/lock.port';
import {
  AGGREGATE_LEASE_TTL_MS,
  AGGREGATES_PER_POLL,
  BACKLOG_GAUGE_INTERVAL_MS,
  CANDIDATES_PER_POLL,
  LEASE_RENEW_INTERVAL_MS,
  MAX_ATTEMPTS,
  OUTBOX_AGGREGATE_LEASE,
  OUTBOX_POLL_INTERVAL_MS,
  OUTBOX_BACKLOG_METRIC,
  OUTBOX_PUBLISH_FAILED_METRIC,
  OUTBOX_PUBLISHED_METRIC,
  OUTBOX_RELAY_LAST_POLL_METRIC,
  OUTBOX_PUBLISH_TIMEOUT_MS,
  OUTBOX_REPOLL_DELAY_MS,
  OUTBOX_EVENT_SOURCE,
  ROWS_PER_AGGREGATE,
} from './outbox.constants';
import { OutboxStatus, type OutboxDocument } from './outbox.schema';

/** The CloudEvents attributes of a row. */
export function eventAttributesOf(row: OutboxDocument): {
  event: EventAttributes;
  traceparent?: string;
  tracestate?: string;
} {
  return {
    event: {
      id: row.event.id,
      type: row.event.type,
      subject: row.event.subject ?? row.aggregateId,
      tenantId: row.event.tenantId,
      schemaVersion: row.event.schemaVersion,
      time: new Date(row.event.time).toISOString(),
      source: OUTBOX_EVENT_SOURCE,
    },
    traceparent: row.event.traceparent,
    tracestate: row.event.tracestate,
  };
}

/** Fisher-Yates, in place. */
function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** How a poll ended: `full` means work was left over, so poll again now. */
type PollOutcome = { full: boolean };

type AggregateOutcome =
  | 'held'
  | 'relayed'
  | 'drained'
  | 'lock-down'
  | 'messaging-disabled';

type PublishOutcome = 'published' | 'failed' | 'messaging-disabled';

function relayMetrics() {
  return {
    published: counter(
      OUTBOX_PUBLISHED_METRIC,
      'Outbox events published to the broker',
      [] as const,
    ),
    failed: counter(
      OUTBOX_PUBLISH_FAILED_METRIC,
      'Failed outbox publish attempts, by the status the row moved to',
      ['result'] as const,
    ),
  };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Publish timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function isDue(row: OutboxDocument, now: number): boolean {
  if (row.status === OutboxStatus.PENDING) return true;
  if (row.status !== OutboxStatus.FAILED) return false;
  return !row.nextAttemptAt || row.nextAttemptAt.getTime() <= now;
}

/**
 * Publishes outbox rows to the message broker as CloudEvents (binary mode:
 * the row's event attributes become the `ce_*` properties, its payload the
 * body, its stored traceparent the parent of the publish span).
 *
 * Any number of instances run this at once. Each poll reads a window of due
 * aggregates (in random order when it is wider than a batch, so instances
 * spread out), skips those whose lease another instance holds, and publishes
 * one aggregate at a time while holding its lease, re-reading the head row
 * under the lease, so an aggregate's events leave in order and no row is
 * published by two instances at once. The lease outlives the publish
 * timeout and is renewed while a publish is in flight. A poll that relayed a
 * full batch is followed by another at once; otherwise the relay waits
 * OUTBOX_POLL_INTERVAL_MS. Every message is keyed by its aggregate id, so
 * the broker keeps an aggregate's events in order to keyed consumers.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = createLogger('outbox');
  private inFlight: Promise<void> | null = null;
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;
  private headsRepaired = false;
  private disabledLogged = false;

  constructor(
    private readonly outboxService: OutboxService,
    @Inject(MESSAGING) private readonly broker: MessagingPort,
    @Inject(LOCK) private readonly lock: LockPort,
    @InjectMetric(OUTBOX_BACKLOG_METRIC)
    private readonly rowsGauge: Gauge<'status'>,
    @InjectMetric(OUTBOX_RELAY_LAST_POLL_METRIC)
    private readonly lastPollGauge: Gauge<string>,
  ) {}

  /**
   * Polls OUTBOX_POLL_INTERVAL_MS after the end of a partial poll and
   * OUTBOX_REPOLL_DELAY_MS after a full one, and refreshes this instance's
   * backlog gauge every BACKLOG_GAUGE_INTERVAL_MS so every relay's series
   * stays current.
   */
  onApplicationBootstrap(): void {
    let gaugeAt = 0;
    const tick = (delayMs: number): void => {
      this.timer = setTimeout(() => {
        let full = false;
        void (async () => {
          full = (await this.relay()).full;
          if (
            !this.stopping &&
            Date.now() - gaugeAt >= BACKLOG_GAUGE_INTERVAL_MS
          ) {
            gaugeAt = Date.now();
            await this.publishBacklogGauge();
          }
        })().finally(() => {
          if (!this.stopping) {
            tick(full ? OUTBOX_REPOLL_DELAY_MS : OUTBOX_POLL_INTERVAL_MS);
          }
        });
      }, delayMs);
    };
    tick(OUTBOX_POLL_INTERVAL_MS);
  }

  async relay(): Promise<PollOutcome> {
    if (this.inFlight || this.stopping) return { full: false };
    const poll = this.poll();
    this.inFlight = poll.then(() => undefined);
    try {
      return await poll;
    } finally {
      this.inFlight = null;
    }
  }

  /** Stops new polls and waits for the one in flight, before connections close. */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  private async poll(): Promise<PollOutcome> {
    let full = false;
    try {
      if (!this.headsRepaired) {
        await this.outboxService.repairHeads();
        this.headsRepaired = true;
      }
      const candidates =
        await this.outboxService.dueAggregates(CANDIDATES_PER_POLL);
      const order =
        candidates.length > AGGREGATES_PER_POLL
          ? shuffle([...candidates])
          : candidates;
      let relayed = 0;
      for (const aggregateId of order) {
        if (this.stopping || relayed >= AGGREGATES_PER_POLL) break;
        const outcome = await this.relayAggregate(aggregateId);
        if (outcome === 'lock-down' || outcome === 'messaging-disabled') {
          return { full: false };
        }
        if (outcome === 'held') continue;
        relayed += 1;
        if (outcome === 'drained') full = true;
      }
      if (relayed >= AGGREGATES_PER_POLL) full = true;
      // Heartbeat of a completed poll: a relay that cannot read the outbox or
      // take leases lets it go stale, which is what OutboxRelayStalled watches.
      this.lastPollGauge.set(Date.now() / 1000);
    } catch (err) {
      this.logger.error('relay-poll-failed', 'Outbox relay poll failed', err);
      return { full: false };
    }
    return { full: full && !this.stopping };
  }

  /**
   * `held`: another instance holds the lease; `drained`: ROWS_PER_AGGREGATE
   * rows went out and more may be waiting; `lock-down`: the lease store is
   * unavailable and the poll should stop.
   */
  private async relayAggregate(aggregateId: string): Promise<AggregateOutcome> {
    let lease: Lease | null;
    try {
      lease = await this.lock.acquire(
        OUTBOX_AGGREGATE_LEASE.global(aggregateId),
        AGGREGATE_LEASE_TTL_MS,
      );
    } catch (err) {
      // Loud: a lock-store outage is otherwise indistinguishable from
      // "another instance holds the lease", and events pile up unrelayed.
      this.logger.error(
        'relay-lock-unavailable',
        'Outbox lease store unavailable; events are not being relayed',
        err,
      );
      return 'lock-down';
    }
    if (!lease) return 'held';

    try {
      for (let i = 0; i < ROWS_PER_AGGREGATE; i += 1) {
        const row = await this.outboxService.headOf(aggregateId);
        if (!row || !isDue(row, Date.now())) return 'relayed';
        if (!(await lease.renew(AGGREGATE_LEASE_TTL_MS).catch(() => false))) {
          this.logger.warn(
            'relay-lease-lost',
            'Outbox relay lost an aggregate lease; its rows stay open',
            { 'outbox.aggregate_id': aggregateId },
          );
          return 'relayed';
        }
        const outcome = await this.withRenewal(lease, () => this.publish(row));
        if (outcome === 'messaging-disabled') return outcome;
        if (outcome === 'failed') return 'relayed';
      }
      return 'drained';
    } finally {
      await this.outboxService
        .settleHead(aggregateId)
        .catch((err: unknown) =>
          this.logger.warn(
            'head-settle-failed',
            'Outbox head not updated; the sweep repairs it',
            { 'outbox.aggregate_id': aggregateId },
            err,
          ),
        );
      await lease.release().catch(() => undefined);
    }
  }

  /** Keeps the lease alive while `work` runs. */
  private async withRenewal<T>(
    lease: Lease,
    work: () => Promise<T>,
  ): Promise<T> {
    const heartbeat = setInterval(() => {
      void lease.renew(AGGREGATE_LEASE_TTL_MS).catch(() => false);
    }, LEASE_RENEW_INTERVAL_MS);
    try {
      return await work();
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async publish(row: OutboxDocument): Promise<PublishOutcome> {
    const { event, traceparent, tracestate } = eventAttributesOf(row);
    const fields = {
      'outbox.row_id': row._id.toString(),
      'cloudevents.event_id': event.id,
      'outbox.aggregate_id': row.aggregateId,
      'outbox.attempts': (row.attempts ?? 0) + 1,
    };
    const metrics = relayMetrics();
    try {
      await withTimeout(
        runInExtractedContext(
          { traceparent, tracestate },
          { tenantId: event.tenantId },
          () =>
            this.broker.publish(row.topic, row.payload ?? {}, {
              event,
              key: row.aggregateId,
            }),
        ),
        OUTBOX_PUBLISH_TIMEOUT_MS,
      );
    } catch (err) {
      if (err instanceof CapabilityDisabledError) {
        // Nothing can be published: the rows wait, with their attempts
        // untouched, for messaging to be switched on.
        if (!this.disabledLogged) {
          this.disabledLogged = true;
          this.logger.warn(
            'messaging-disabled',
            'Messaging is disabled; outbox rows stay pending',
          );
        }
        return 'messaging-disabled';
      }
      await this.recordFailure(row, err, fields);
      return 'failed';
    }
    metrics.published.inc();
    try {
      await this.outboxService.markDispatched(row._id.toString());
    } catch (err) {
      // The event is out; the row stays open and is published again later,
      // which consumers dedup on the event id. It is not a failed attempt.
      this.logger.warn(
        'mark-dispatched-failed',
        'Outbox event published but the row was not marked dispatched; it will be published again',
        fields,
        err,
      );
      return 'failed';
    }
    return 'published';
  }

  private async recordFailure(
    row: OutboxDocument,
    err: unknown,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    let status: OutboxStatus.FAILED | OutboxStatus.DEAD | null;
    try {
      status = await this.outboxService.markFailed(row, message, MAX_ATTEMPTS);
    } catch (markErr) {
      this.logger.warn(
        'mark-failed-failed',
        'Outbox publish failed and the failure could not be recorded; the row is retried',
        fields,
        markErr,
      );
      return;
    }
    if (status === null) {
      this.logger.warn(
        'publish-failed-stale',
        'Outbox publish failed after the row was already published elsewhere; left as it is',
        fields,
        err,
      );
      return;
    }
    relayMetrics().failed.inc({
      result: status === OutboxStatus.DEAD ? 'dead' : 'failed',
    });
    if (status === OutboxStatus.DEAD) {
      // Needs a human: the aggregate stays blocked until redrive or skip.
      this.logger.error(
        'row-dead',
        'Outbox row is DEAD after its last attempt; its aggregate is blocked until redrive or skip',
        err,
        fields,
      );
    } else {
      this.logger.warn('publish-failed', 'Outbox publish failed', fields, err);
    }
  }

  /** Run by OutboxSweepJob, which the scheduler enqueues once a minute. */
  async sweep(): Promise<void> {
    if (this.stopping) return;
    try {
      const dead = await this.outboxService.deadLetterExhausted(MAX_ATTEMPTS);
      const backlog = await this.outboxService.countDead();
      const repaired = await this.outboxService.repairHeads();
      if (repaired > 0) {
        this.logger.info('heads-repaired', 'Outbox heads repaired', {
          'outbox.heads_repaired': repaired,
        });
      }
      if (dead > 0 || backlog > 0) {
        this.logger.error(
          'dead-backlog',
          'Outbox has DEAD rows blocking their aggregates',
          undefined,
          {
            'outbox.dead_lettered': dead,
            'outbox.dead_backlog': backlog,
          },
        );
      }
    } catch (err) {
      this.logger.warn('sweep-failed', 'Outbox sweep failed', {}, err);
    }
    await this.publishBacklogGauge();
  }

  /**
   * Exports the backlog as tropis_outbox_backlog_rows{status="..."}: one grouped
   * query per relay instance per minute, so the alert rules in
   * infra/prometheus/alerts.yml cost nothing on the request path.
   */
  private async publishBacklogGauge(): Promise<void> {
    try {
      const counts = await this.outboxService.backlogByStatus();
      for (const [status, count] of Object.entries(counts)) {
        this.rowsGauge.set({ status }, count);
      }
    } catch (err) {
      this.logger.warn(
        'backlog-gauge-failed',
        'Outbox backlog gauge refresh failed',
        {},
        err,
      );
    }
  }
}
