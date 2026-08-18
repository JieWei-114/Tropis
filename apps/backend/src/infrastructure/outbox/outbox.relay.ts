import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import Redis from 'ioredis';
import { OutboxService } from './outbox.service';
import { MESSAGE_BROKER } from '../messaging/message-broker.port';
import type { MessageBrokerPort } from '../messaging/message-broker.port';
import { REDIS_CLIENT } from '../redis/redis.module';
import { randomUUID } from 'crypto';

const RELAY_LOCK_KEY = 'outbox:relay:lock';
const RELAY_LOCK_TTL_MS = 8_000;

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
  ) {}

  @Cron(CronExpression.EVERY_5_SECONDS)
  async relay() {
    // Distributed lock — only one instance relays at a time.
    const lockId = randomUUID();
    const acquired = await this.redis
      .set(RELAY_LOCK_KEY, lockId, 'PX', RELAY_LOCK_TTL_MS, 'NX')
      .catch(() => null);
    if (!acquired) return;

    try {
      await this.runRelay();
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

  private async runRelay() {
    const batch = await this.outboxService.pendingBatch(50);
    if (!batch.length) return;

    for (const row of batch) {
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
      }
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async requeue() {
    await this.outboxService.requeueFailed(5);
  }
}
