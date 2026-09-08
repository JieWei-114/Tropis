/**
 * Outbox integration test — real MongoDB (mongo:7 single-node replica set,
 * required for multi-document transactions).
 *
 * Verifies:
 *   1. AnalyticsService.create writes the EventLog + outbox row atomically.
 *   2. A failure inside the transaction rolls back both writes.
 *   3. The relay (with a mocked Pulsar producer) marks a row dispatched
 *      exactly once.
 *   4. A failing publish leaves the row un-dispatched (failed → requeued
 *      back to pending).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type Redis from 'ioredis';
import type { Gauge } from 'prom-client';
import type { MessageBrokerPort } from '../../src/infrastructure/messaging/message-broker.port';
import {
  MongoDBContainer,
  StartedMongoDBContainer,
} from '@testcontainers/mongodb';
import { OutboxService } from '../../src/infrastructure/outbox/outbox.service';
import { OutboxRelay } from '../../src/infrastructure/outbox/outbox.relay';
import {
  Outbox,
  OutboxDocument,
  OutboxSchema,
  OutboxStatus,
} from '../../src/infrastructure/outbox/outbox.schema';
import { AnalyticsService } from '../../src/modules/analytics/services/analytics.service';
import { EventLogRepository } from '../../src/modules/analytics/repositories/event-log.repository';
import { AnalyticsRepository } from '../../src/modules/analytics/repositories/analytics.repository';
import {
  EventLog,
  EventLogSchema,
  AnalyticsEventType,
} from '../../src/modules/analytics/schemas/event-log.schema';
import { REDIS_CLIENT } from '../../src/infrastructure/redis/redis.module';
import { describeWithDocker } from './docker';

jest.setTimeout(240_000);

describeWithDocker('Outbox (integration)')('Outbox (integration)', () => {
  let mongo: StartedMongoDBContainer;
  let moduleRef: TestingModule;
  let analyticsService: AnalyticsService;
  let outboxService: OutboxService;
  let outboxModel: Model<OutboxDocument>;
  let eventLogModel: Model<EventLog>;

  const redisStub = { del: jest.fn().mockResolvedValue(1) };

  beforeAll(async () => {
    mongo = await new MongoDBContainer('mongo:7').start();

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getConnectionString(), {
          directConnection: true,
        }),
        MongooseModule.forFeature([
          { name: Outbox.name, schema: OutboxSchema },
          { name: EventLog.name, schema: EventLogSchema },
        ]),
      ],
      providers: [
        OutboxService,
        EventLogRepository,
        AnalyticsService,
        // ClickHouse-backed repo — not under test here
        {
          provide: AnalyticsRepository,
          useValue: { getStatsByType: jest.fn(), getMinutelyStats: jest.fn() },
        },
        { provide: REDIS_CLIENT, useValue: redisStub },
      ],
    }).compile();

    await moduleRef.init();

    analyticsService = moduleRef.get(AnalyticsService);
    outboxService = moduleRef.get(OutboxService);
    outboxModel = moduleRef.get(getModelToken(Outbox.name));
    eventLogModel = moduleRef.get(getModelToken(EventLog.name));
  });

  afterAll(async () => {
    await moduleRef?.close();
    await mongo?.stop();
  });

  beforeEach(async () => {
    await Promise.all([
      outboxModel.deleteMany({}),
      eventLogModel.deleteMany({}),
    ]);
    jest.restoreAllMocks();
  });

  const dto = {
    eventType: AnalyticsEventType.PAGE_VIEW,
    userId: 'user-1',
    metadata: { page: '/home' },
  };

  it('writes the event log and outbox row atomically in one transaction', async () => {
    const event = await analyticsService.create(dto as never);

    const logs = await eventLogModel.find().exec();
    const rows = await outboxModel.find().exec();

    expect(logs).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].aggregateId).toBe(logs[0].eventId);
    expect(rows[0].eventType).toBe(AnalyticsEventType.PAGE_VIEW);
    expect(rows[0].status).toBe(OutboxStatus.PENDING);
    expect(event.eventType).toBe(AnalyticsEventType.PAGE_VIEW);
    // cache-bust happened after commit
    expect(redisStub.del).toHaveBeenCalled();
  });

  it('rolls back the event log when the outbox write fails (atomicity)', async () => {
    jest
      .spyOn(outboxService, 'write')
      .mockRejectedValueOnce(new Error('outbox write boom'));

    await expect(analyticsService.create(dto as never)).rejects.toThrow(
      'outbox write boom',
    );

    // neither side of the transaction survived
    expect(await eventLogModel.countDocuments().exec()).toBe(0);
    expect(await outboxModel.countDocuments().exec()).toBe(0);
  });

  describe('relay dispatch (mocked message broker)', () => {
    const makeRelay = (send: jest.Mock) => {
      const broker = {
        publish: send,
        subscribe: jest.fn(),
        close: jest.fn().mockResolvedValue(undefined),
      } as MessageBrokerPort;
      // Redis fake that always grants the distributed lock
      const redis = {
        set: jest.fn().mockResolvedValue('OK'),
        eval: jest.fn().mockResolvedValue(1),
      } as unknown as Redis;
      // Gauge stubs — the relay publishes backlog/heartbeat metrics, which are
      // not what these tests assert on.
      const gauge = { set: jest.fn() } as unknown as Gauge<string>;
      return {
        relay: new OutboxRelay(
          outboxService,
          broker,
          redis,
          gauge as Gauge<'status'>,
          gauge,
        ),
        broker,
      };
    };

    it('marks a pending row dispatched exactly once', async () => {
      await outboxService.write('agg-1', 'analytics.event', { a: 1 });

      const send = jest.fn().mockResolvedValue(undefined);
      const { relay } = makeRelay(send);

      await relay.relay();

      const [row] = await outboxModel.find().exec();
      expect(row.status).toBe(OutboxStatus.DISPATCHED);
      expect(row.dispatchedAt).toBeInstanceOf(Date);
      expect(send).toHaveBeenCalledTimes(1);

      // second pass: nothing pending, no re-publish
      await relay.relay();
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('leaves the row un-dispatched when the publish fails, and requeues it', async () => {
      await outboxService.write('agg-2', 'analytics.event', { b: 2 });

      const send = jest.fn().mockRejectedValue(new Error('pulsar down'));
      const { relay } = makeRelay(send);

      await relay.relay();

      let [row] = await outboxModel.find().exec();
      expect(row.status).toBe(OutboxStatus.FAILED);
      expect(row.status).not.toBe(OutboxStatus.DISPATCHED);
      expect(row.attempts).toBe(1);
      expect(row.lastError).toContain('pulsar down');

      // A failed row is NOT immediately eligible: markFailed schedules
      // nextAttemptAt with exponential backoff (5s * 2^(attempts-1)), so a
      // requeue pass right away must leave it alone. That is the point of the
      // backoff: without it a permanently failing topic is retried at full
      // rate every minute.
      expect(row.nextAttemptAt).toBeInstanceOf(Date);
      await outboxService.requeueFailed(5);
      [row] = await outboxModel.find().exec();
      expect(row.status).toBe(OutboxStatus.FAILED);

      // Once the backoff has elapsed, the same pass requeues it.
      await outboxModel.updateOne(
        { _id: row._id },
        { $set: { nextAttemptAt: new Date(Date.now() - 1000) } },
      );
      await outboxService.requeueFailed(5);
      [row] = await outboxModel.find().exec();
      expect(row.status).toBe(OutboxStatus.PENDING);
    });

    it('dead-letters a row once its attempts are exhausted', async () => {
      await outboxService.write('agg-3', 'analytics.event', { c: 3 });
      let [row] = await outboxModel.find().exec();

      await outboxModel.updateOne(
        { _id: row._id },
        { $set: { status: OutboxStatus.FAILED, attempts: 5 } },
      );

      expect(await outboxService.deadLetterExhausted(5)).toBe(1);
      [row] = await outboxModel.find().exec();
      expect(row.status).toBe(OutboxStatus.DEAD);
      expect(await outboxService.countDead()).toBe(1);

      // A DEAD row is terminal: it must never be requeued again.
      await outboxService.requeueFailed(5);
      [row] = await outboxModel.find().exec();
      expect(row.status).toBe(OutboxStatus.DEAD);
    });
  });
});
