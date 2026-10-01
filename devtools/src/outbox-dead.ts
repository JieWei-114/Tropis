/**
 * Operator actions on DEAD outbox rows (src/infrastructure/outbox). A DEAD
 * row has exhausted its retries and blocks its aggregate: none of the
 * aggregate's later events are published until the row is redriven or
 * skipped. Connects straight to MongoDB, like outbox-status, and applies the
 * same transitions as OutboxService.redrive() / skip():
 *
 *   list                      DEAD rows, oldest first
 *   redrive ID=<row id>       DEAD -> PENDING with a fresh attempt budget
 *   redrive AGGREGATE=<id>    every DEAD row of the aggregate
 *   skip ID=<row id>          DEAD -> SKIPPED: the event is never published,
 *   skip AGGREGATE=<id>       and the aggregate's later events flow again
 *
 * Only DEAD rows are touched; any other row matching the selector is left
 * alone.
 *
 * Run: `make outbox-dead`, `make outbox-redrive ID=...`, `make outbox-skip ID=...`
 */
import * as path from 'path';
import { config } from 'dotenv';
import mongoose from 'mongoose';

config({
  path: path.resolve(
    import.meta.dirname,
    '..',
    '..',
    'apps',
    'backend',
    '.env',
  ),
});

const MONGODB_URI =
  process.env.MONGODB_URI ??
  'mongodb://localhost:27018/tropis?directConnection=true';

function selector(): Record<string, unknown> {
  const id = process.env.ID;
  const aggregateId = process.env.AGGREGATE;
  if (id && aggregateId) throw new Error('Pass ID or AGGREGATE, not both');
  if (id) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error(`Invalid row id ${JSON.stringify(id)}`);
    }
    return { _id: new mongoose.Types.ObjectId(id) };
  }
  if (aggregateId) return { aggregateId };
  throw new Error('Pass ID=<row id> or AGGREGATE=<aggregate id>');
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'list';
  const conn = await mongoose
    .createConnection(MONGODB_URI, { serverSelectionTimeoutMS: 3000 })
    .asPromise();
  const outbox = conn.collection('outbox');
  const heads = conn.collection<{ _id: string }>('outbox_heads');
  // Puts the aggregates' heads in line now, as OutboxService.requeue() does.
  const requeue = async (aggregates: string[]) => {
    const now = new Date();
    for (const id of aggregates) {
      await heads.updateOne(
        { _id: id },
        { $set: { dueAt: now }, $inc: { v: 1 } },
        { upsert: true },
      );
    }
  };
  try {
    if (command === 'list') {
      const rows = await outbox
        .find({ status: 'dead' })
        .sort({ createdAt: 1, _id: 1 })
        .limit(50)
        .toArray();
      if (rows.length === 0) console.log('No DEAD rows.');
      for (const row of rows) {
        const type = (row.event as { type?: string } | undefined)?.type;
        console.log(
          `${row._id.toString()}  aggregate ${String(row.aggregateId)}  ${String(type)}` +
            `  attempts ${String(row.attempts ?? 0)}` +
            (row.lastError
              ? `  lastError: ${String(row.lastError).split('\n')[0]}`
              : ''),
        );
      }
      return;
    }
    const filter = { ...selector(), status: 'dead' };
    const aggregates = (await outbox.distinct('aggregateId', filter)).map(
      String,
    );
    if (command === 'redrive') {
      const res = await outbox.updateMany(filter, {
        $set: { status: 'pending', attempts: 0, nextAttemptAt: null },
      });
      await requeue(aggregates);
      console.log(`Redrove ${res.modifiedCount} DEAD row(s).`);
      return;
    }
    if (command === 'skip') {
      const days = Number(process.env.OUTBOX_RETENTION_DAYS ?? 7);
      const now = Date.now();
      const res = await outbox.updateMany(filter, {
        $set: {
          status: 'skipped',
          skippedAt: new Date(now),
          expireAt: new Date(now + days * 24 * 60 * 60 * 1000),
        },
      });
      await requeue(aggregates);
      console.log(`Skipped ${res.modifiedCount} DEAD row(s).`);
      return;
    }
    throw new Error(`Unknown command ${command}: use list, redrive or skip`);
  } finally {
    await conn.close();
  }
}

main().catch((err) => {
  console.error(
    `outbox-dead failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
