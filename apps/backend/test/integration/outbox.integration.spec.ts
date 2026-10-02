/**
 * Outbox integration test — real MongoDB (mongo:7 single-node replica set,
 * required for multi-document transactions).
 *
 * Verifies:
 *   1. A domain write and its outbox row (with its event attributes) commit
 *      in one transaction, and a failure rolls both back. The aggregate is
 *      test-local, so the foundation suite depends on no product feature.
 *   2. Two relay instances running at once publish every row exactly once and
 *      each aggregate's rows in order (per-aggregate leases, no global lock).
 *   3. A failed publish holds back only its own aggregate until the backoff
 *      has elapsed; a FAILED row without nextAttemptAt is due.
 *   4. A DEAD row blocks its aggregate until an operator skips or redrives it.
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  MongooseModule,
  getConnectionToken,
  getModelToken,
} from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import { Schema, type Connection, type Model } from 'mongoose';
import {
  DOCUMENTS,
  type DocumentsPort,
} from '../../src/infrastructure/documents/documents.port';
import { sessionOf } from '../../src/infrastructure/documents/transaction';
import { MongooseDocumentsAdapter } from '../../src/infrastructure/documents/adapters/mongoose/mongoose-documents.adapter';
import type { Gauge } from 'prom-client';
import type {
  MessagingPort,
  PublishOptions,
} from '../../src/infrastructure/messaging/messaging.port';
import {
  MongoDBContainer,
  StartedMongoDBContainer,
} from '@testcontainers/mongodb';
import { OutboxService } from '../../src/infrastructure/outbox/outbox.service';
import { OutboxRelay } from '../../src/infrastructure/outbox/outbox.relay';
import {
  Outbox,
  OutboxDocument,
  OutboxHead,
  OutboxHeadDocument,
  OutboxHeadSchema,
  OutboxSchema,
  OutboxStatus,
} from '../../src/infrastructure/outbox/outbox.schema';
import type { LockPort } from '../../src/infrastructure/lock/lock.port';
import { InMemoryLockAdapter } from '../../src/infrastructure/lock/__tests__/in-memory-lock.adapter';
import { describeWithDocker } from './docker';

jest.setTimeout(240_000);

const TOPIC = 'user-events';

const PROBE_TOPIC = 'probe-events';
const PROBE_RECORDED = 'probe.record.recorded';

interface ProbeRecord {
  recordId: string;
  tenantId: string;
  label: string;
}

const ProbeRecordSchema = new Schema<ProbeRecord>(
  {
    recordId: { type: String, required: true },
    tenantId: { type: String, required: true },
    label: { type: String, required: true },
  },
  { collection: 'outbox_probe_records', versionKey: false },
);

interface Sent {
  aggregateId: string;
  seq: number;
  eventId?: string;
  relay: string;
}

describeWithDocker('Outbox (integration)')('Outbox (integration)', () => {
  let mongo: StartedMongoDBContainer;
  let moduleRef: TestingModule;
  let documents: DocumentsPort;
  let outboxService: OutboxService;
  let outboxModel: Model<OutboxDocument>;
  let headModel: Model<OutboxHeadDocument>;
  let probeModel: Model<ProbeRecord>;

  beforeAll(async () => {
    mongo = await new MongoDBContainer('mongo:7').start();

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getConnectionString(), {
          directConnection: true,
        }),
        MongooseModule.forFeature([
          { name: Outbox.name, schema: OutboxSchema },
          { name: OutboxHead.name, schema: OutboxHeadSchema },
          { name: 'ProbeRecord', schema: ProbeRecordSchema },
        ]),
      ],
      providers: [
        OutboxService,
        {
          provide: DOCUMENTS,
          inject: [getConnectionToken()],
          useFactory: (connection: Connection) =>
            new MongooseDocumentsAdapter(connection),
        },
      ],
    }).compile();

    await moduleRef.init();

    documents = moduleRef.get(DOCUMENTS);
    outboxService = moduleRef.get(OutboxService);
    outboxModel = moduleRef.get(getModelToken(Outbox.name));
    headModel = moduleRef.get(getModelToken(OutboxHead.name));
    await headModel.syncIndexes();
    probeModel = moduleRef.get(getModelToken('ProbeRecord'));
    await outboxModel.syncIndexes();
  });

  afterAll(async () => {
    await moduleRef?.close();
    await mongo?.stop();
  });

  beforeEach(async () => {
    await Promise.all([
      outboxModel.deleteMany({}),
      headModel.deleteMany({}),
      probeModel.deleteMany({}),
    ]);
    jest.restoreAllMocks();
  });

  const record = (label: string) => {
    const recordId = randomUUID();
    return documents.withTransaction(async (tx) => {
      await probeModel.create([{ recordId, tenantId: 'acme', label }], {
        session: sessionOf(tx),
      });
      await outboxService.write(
        {
          topic: PROBE_TOPIC,
          aggregateId: recordId,
          id: recordId,
          type: PROBE_RECORDED,
          tenantId: 'acme',
          data: { recordId, label, tenantId: 'acme' },
        },
        tx,
      );
      return recordId;
    });
  };

  it('writes the domain record and outbox row atomically in one transaction', async () => {
    const recordId = await record('home');

    const records = await probeModel.find({ tenantId: 'acme' }).exec();
    const rows = await outboxModel.find().exec();

    expect(records).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].aggregateId).toBe(recordId);
    expect(rows[0].topic).toBe(PROBE_TOPIC);
    expect(rows[0].status).toBe(OutboxStatus.PENDING);
    expect(rows[0].event).toMatchObject({
      id: recordId,
      type: PROBE_RECORDED,
      tenantId: 'acme',
      schemaVersion: '1',
    });
    expect(rows[0].payload.label).toBe('home');
  });

  it('rolls back the domain record when the outbox write fails (atomicity)', async () => {
    jest
      .spyOn(outboxService, 'write')
      .mockRejectedValueOnce(new Error('outbox write boom'));

    await expect(record('home')).rejects.toThrow('outbox write boom');

    expect(await probeModel.countDocuments().exec()).toBe(0);
    expect(await outboxModel.countDocuments().exec()).toBe(0);
  });

  describe('relay', () => {
    const lock = () => new InMemoryLockAdapter();
    let sent: Sent[];
    let failFor: Set<string>;

    const broker = (name: string): MessagingPort => ({
      publish: async (_t: string, payload: object, opts?: PublishOptions) => {
        const body = payload as { seq: number };
        const aggregateId = opts?.event?.subject ?? '';
        if (failFor.has(aggregateId)) throw new Error('broker down');
        await new Promise((r) => setTimeout(r, 2));
        sent.push({
          aggregateId,
          seq: body.seq,
          eventId: opts?.event?.id,
          relay: name,
        });
      },
      subscribe: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    });

    const relay = (name: string, leases: LockPort) => {
      const gauge = { set: jest.fn() } as unknown as Gauge<string>;
      return new OutboxRelay(
        outboxService,
        broker(name),
        leases,
        gauge as Gauge<'status'>,
        gauge,
      );
    };

    const write = (aggregateId: string, seq: number) =>
      outboxService.write({
        topic: TOPIC,
        aggregateId,
        type: 'identity.user.updated',
        tenantId: 'acme',
        data: { seq },
      });

    const statuses = async (aggregateId: string) =>
      (
        await outboxModel
          .find({ aggregateId })
          .sort({ createdAt: 1, _id: 1 })
          .exec()
      ).map((r) => r.status);

    beforeEach(() => {
      sent = [];
      failFor = new Set();
    });

    it('two instances publish every row once, each aggregate in order', async () => {
      for (let seq = 0; seq < 6; seq += 1) {
        for (const agg of ['a', 'b', 'c', 'd']) await write(agg, seq);
      }
      const leases = lock();
      const a = relay('A', leases);
      const b = relay('B', leases);

      for (let i = 0; i < 3; i += 1) await Promise.all([a.relay(), b.relay()]);

      expect(sent).toHaveLength(24);
      expect(new Set(sent.map((s) => s.eventId)).size).toBe(24);
      for (const agg of ['a', 'b', 'c', 'd']) {
        expect(
          sent.filter((s) => s.aggregateId === agg).map((s) => s.seq),
        ).toEqual([0, 1, 2, 3, 4, 5]);
      }
      expect(
        await outboxModel.countDocuments({ status: OutboxStatus.DISPATCHED }),
      ).toBe(24);
    });

    it('holds back only the failing aggregate until its backoff has elapsed', async () => {
      await write('x', 0);
      await write('x', 1);
      await write('y', 0);
      failFor.add('x');
      const r = relay('A', lock());

      await r.relay();
      expect(await statuses('x')).toEqual([
        OutboxStatus.FAILED,
        OutboxStatus.PENDING,
      ]);
      expect(await statuses('y')).toEqual([OutboxStatus.DISPATCHED]);

      failFor.clear();
      await r.relay();
      expect(sent.filter((s) => s.aggregateId === 'x')).toHaveLength(0);

      await outboxModel.updateMany(
        { aggregateId: 'x', status: OutboxStatus.FAILED },
        { $set: { nextAttemptAt: new Date(Date.now() - 1000) } },
      );
      await outboxService.repairHeads();
      await r.relay();
      expect(
        sent.filter((s) => s.aggregateId === 'x').map((s) => s.seq),
      ).toEqual([0, 1]);
    });

    it('a stale failure never flips a DISPATCHED row back to FAILED', async () => {
      await write('s', 0);
      const [row] = await outboxModel.find({ aggregateId: 's' }).exec();
      await outboxService.markDispatched(row._id.toString());

      await expect(
        outboxService.markFailed(row, 'late timeout'),
      ).resolves.toBeNull();
      expect(await statuses('s')).toEqual([OutboxStatus.DISPATCHED]);
    });

    it('publishes each event keyed by its aggregate id', async () => {
      await write('k', 0);
      const keys: Array<string | undefined> = [];
      const gauge = { set: jest.fn() } as unknown as Gauge<string>;
      await new OutboxRelay(
        outboxService,
        {
          publish: (_t: string, _p: object, opts?: PublishOptions) => {
            keys.push(opts?.key);
            return Promise.resolve();
          },
          subscribe: jest.fn(),
          close: jest.fn(),
        },
        lock(),
        gauge as Gauge<'status'>,
        gauge,
      ).relay();
      expect(keys).toEqual(['k']);
    });

    it('treats a FAILED row without nextAttemptAt as due', async () => {
      await outboxModel.collection.insertOne({
        aggregateId: 'legacy',
        event: {
          id: 'evt-legacy',
          type: 'identity.user.updated',
          tenantId: 'acme',
          time: new Date(),
          schemaVersion: '1',
        },
        topic: TOPIC,
        payload: { seq: 0, tenantId: 'acme' },
        status: OutboxStatus.FAILED,
        attempts: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      expect(await outboxService.dueAggregates(10)).toEqual([]);
      await outboxService.repairHeads();
      expect(await outboxService.dueAggregates(10)).toEqual(['legacy']);
      await relay('A', lock()).relay();

      expect(sent).toEqual([
        {
          aggregateId: 'legacy',
          seq: 0,
          eventId: 'evt-legacy',
          relay: 'A',
        },
      ]);
    });

    it('moves a row to DEAD after its last attempt; skip releases the aggregate', async () => {
      await write('z', 0);
      await write('z', 1);
      await outboxModel.updateOne(
        { aggregateId: 'z', 'payload.seq': 0 },
        { $set: { status: OutboxStatus.FAILED, attempts: 4 } },
      );
      await outboxService.repairHeads();
      failFor.add('z');
      const r = relay('A', lock());

      await r.relay();
      expect(await statuses('z')).toEqual([
        OutboxStatus.DEAD,
        OutboxStatus.PENDING,
      ]);
      expect(await outboxService.countDead()).toBe(1);

      failFor.clear();
      await r.relay();
      expect(sent).toHaveLength(0);
      expect(await outboxService.dueAggregates(10)).toEqual([]);

      const [dead] = await outboxService.listDead();
      expect(await outboxService.skip({ id: dead._id.toString() })).toBe(1);
      await r.relay();
      expect(await statuses('z')).toEqual([
        OutboxStatus.SKIPPED,
        OutboxStatus.DISPATCHED,
      ]);
      expect(sent.map((s) => s.seq)).toEqual([1]);
    });

    it('redrive puts a DEAD row back in line ahead of its aggregate', async () => {
      await write('w', 0);
      await write('w', 1);
      await outboxModel.updateOne(
        { aggregateId: 'w', 'payload.seq': 0 },
        { $set: { status: OutboxStatus.DEAD, attempts: 5 } },
      );

      expect(await outboxService.redrive({ aggregateId: 'w' })).toBe(1);
      await relay('A', lock()).relay();

      expect(sent.map((s) => s.seq)).toEqual([0, 1]);
      expect(await statuses('w')).toEqual([
        OutboxStatus.DISPATCHED,
        OutboxStatus.DISPATCHED,
      ]);
    });

    it('retires the head of a drained aggregate and serves candidates from an index', async () => {
      await write('h', 0);
      expect(await headModel.countDocuments({ _id: 'h' })).toBe(1);
      await relay('A', lock()).relay();
      expect(await headModel.countDocuments({ _id: 'h' })).toBe(0);

      const plan = (await headModel
        .find({ dueAt: { $lte: new Date() } }, { _id: 1 })
        .sort({ dueAt: 1 })
        .limit(10)
        .explain('queryPlanner')) as unknown as {
        queryPlanner: { winningPlan: unknown };
      };
      const winning = JSON.stringify(plan.queryPlanner.winningPlan);
      expect(winning).toContain('IXSCAN');
      expect(winning).not.toContain('"SORT"');
    });

    it('expires dispatched rows through a TTL index', async () => {
      await write('t', 0);
      await relay('A', lock()).relay();
      const [row] = await outboxModel.find({ aggregateId: 't' }).exec();
      expect(row.expireAt).toBeInstanceOf(Date);
      const indexes = await outboxModel.collection.indexes();
      expect(
        indexes.find((i) => i.key.expireAt === 1)?.expireAfterSeconds,
      ).toBe(0);
    });
  });
});
