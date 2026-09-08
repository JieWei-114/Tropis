import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Gauge } from 'prom-client';
import Redis from 'ioredis';
import { OutboxService } from './outbox.service';
import {
  OUTBOX_RELAY_LAST_POLL_METRIC,
  OUTBOX_ROWS_METRIC,
} from '../../modules/metrics/metrics.constants';
import { MESSAGE_BROKER } from '../messaging/message-broker.port';
import type { MessageBrokerPort } from '../messaging/message-broker.port';
import { REDIS_CLIENT } from '../redis/redis.module';
import { randomUUID } from 'crypto';

const RELAY_LOCK_KEY = 'outbox:relay:lock';
const RELAY_LOCK_TTL_MS = 8_000;
/** Publish attempts before a row is moved to the terminal DEAD state. */
const MAX_ATTEMPTS = 5;

// Polls the outbox every 5 seconds and publishes PENDING rows to the message
// broker (Pulsar today — see infrastructure/messaging). Each row carries a
// `topic` field; producer caching/reuse lives inside the broker adapter.
@Injectable()
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);

  constructor(
    private readonly outboxService: OutboxService,
    @Inject(MESSAGE_BROKER) private readonly broker: MessageBrokerPort,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectMetric(OUTBOX_ROWS_METRIC)
    private readonly rowsGauge: Gauge<'status'>,
    @InjectMetric(OUTBOX_RELAY_LAST_POLL_METRIC)
    private readonly lastPollGauge: Gauge<string>,
  ) {}

  @Cron(CronExpression.EVERY_5_SECONDS)
  async relay() {
    // Distributed lock — only one instance relays at a time.
    const lockId = randomUUID();
    let acquired: string | null;
    try {
      acquired = await this.redis.set(
        RELAY_LOCK_KEY,
        lockId,
        'PX',
        RELAY_LOCK_TTL_MS,
        'NX',
      );
    } catch (err) {
      // Logged loudly: a Redis outage is otherwise indistinguishable from
      // "another instance holds the lock", and events pile up as PENDING with
      // nothing in the log to say why.
      this.logger.error(
        `Outbox relay lock unavailable (Redis): ${(err as Error).message} — events are NOT being relayed`,
      );
      return;
    }
    if (!acquired) return; // another instance is relaying

    // Heartbeat for the whole relay: only the lock holder gets here, so a
    // stalled or dead relay makes this timestamp go stale on every instance.
    this.lastPollGauge.set(Date.now() / 1000);

    try {
      await this.runRelay(lockId);
    } finally {
      await this.redis
        .eval(
          `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
          1,
          RELAY_LOCK_KEY,
          lockId,
        )
        .catch(() => undefined);
    }
  }

  /** Extends our lock if we still own it. Returns false if ownership was lost. */
  private async renewLock(lockId: string): Promise<boolean> {
    const renewed = await this.redis
      .eval(
        `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`,
        1,
        RELAY_LOCK_KEY,
        lockId,
        String(RELAY_LOCK_TTL_MS),
      )
      .catch(() => 0);
    return renewed === 1;
  }

  private async runRelay(lockId: string) {
    const batch = await this.outboxService.pendingBatch(50);
    if (!batch.length) return;

    // Aggregates whose publish failed in THIS batch. pendingBatch() already
    // excludes aggregates with a FAILED/DEAD row, which is what makes ordering
    // hold across polls; this Set covers the rows already loaded into the
    // current batch, which that query could not have known about.
    const blocked = new Set<string>();

    for (const row of batch) {
      // The lock TTL covers one poll interval, not 50 sequential publishes. If
      // a slow broker made it expire mid-batch, a second instance could start
      // relaying concurrently and double-publish.
      if (!(await this.renewLock(lockId))) {
        this.logger.warn(
          'Outbox relay lost its lock mid-batch — stopping early; remaining rows stay PENDING',
        );
        return;
      }

      if (blocked.has(row.aggregateId)) {
        continue;
      }

      try {
        await this.broker.publish(row.topic, {
          // STABLE id = the outbox row id, so a redelivery (e.g. lock expiry
          // mid-batch) carries the SAME eventId and consumers can dedup.
          // A fresh randomUUID() here would defeat idempotency.
          eventId: row._id.toString(),
          eventType: row.eventType,
          aggregateId: row.aggregateId,
          payload: row.payload,
          timestamp: Date.now(),
        });
        await this.outboxService.markDispatched(row._id.toString());
      } catch (err) {
        const msg = (err as Error).message;
        this.logger.error(
          `Outbox relay failed for ${row._id.toString()}: ${msg}`,
        );
        await this.outboxService.markFailed(row._id.toString(), msg);
        blocked.add(row.aggregateId);
      }
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async requeue() {
    const requeued = await this.outboxService.requeueFailed(MAX_ATTEMPTS);
    const dead = await this.outboxService.deadLetterExhausted(MAX_ATTEMPTS);
    if (dead > 0) {
      const backlog = await this.outboxService.countDead();
      // Loud: these events will never be delivered without intervention.
      this.logger.error(
        `Outbox dead-lettered ${dead} row(s) after ${MAX_ATTEMPTS} attempts — DEAD backlog is now ${backlog}`,
      );
    }
    if (requeued > 0) {
      this.logger.warn(`Outbox requeued ${requeued} failed row(s)`);
    }
    await this.publishBacklogGauge();
  }

  /**
   * Exports the backlog as tropis_outbox_rows{status="..."}. Runs on the
   * existing once-a-minute requeue tick and issues one grouped query, so the
   * alert rules in infra/prometheus/alerts.yml cost a single aggregation per
   * minute rather than anything on the request path.
   */
  private async publishBacklogGauge() {
    try {
      const counts = await this.outboxService.backlogByStatus();
      for (const [status, count] of Object.entries(counts)) {
        this.rowsGauge.set({ status }, count);
      }
    } catch (err) {
      // Never let metrics collection break the requeue cron.
      this.logger.warn(
        `Outbox backlog gauge refresh failed: ${(err as Error).message}`,
      );
    }
  }
}
