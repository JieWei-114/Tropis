/**
 * Outbox health snapshot — connects straight to MongoDB and reports the
 * `outbox` collection (src/infrastructure/outbox): row counts by status
 * (pending / dispatched / failed) plus the 5 oldest non-dispatched rows
 * (topic, eventType, age) so a stuck relay is obvious at a glance.
 *
 * Reads MONGODB_URI from apps/backend/.env (same file the backend loads) so
 * the tool shares backend's config without duplication, falling back to the
 * .env.example default.
 *
 * Run: `make outbox-status`  (→ pnpm --filter @tropis/devtools outbox-status)
 */
import * as path from 'path';
import { config } from 'dotenv';
import mongoose from 'mongoose';

// Deliberately reads backend's .env: devtools/src → repo root → apps/backend/.env
config({ path: path.resolve(import.meta.dirname, '..', '..', 'apps', 'backend', '.env') });

const MONGODB_URI =
  process.env.MONGODB_URI ?? 'mongodb://localhost:27018/tropis?directConnection=true';

const STATUSES = ['pending', 'dispatched', 'failed'] as const;

function age(from: Date): string {
  const s = Math.max(0, Math.floor((Date.now() - from.getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

async function main(): Promise<void> {
  let conn: mongoose.Connection;
  try {
    conn = await mongoose
      .createConnection(MONGODB_URI, { serverSelectionTimeoutMS: 3000 })
      .asPromise();
  } catch (err) {
    console.error(
      `✗ Cannot reach MongoDB at ${MONGODB_URI}` +
        `\n  (${err instanceof Error ? err.message.split('\n')[0] : String(err)})` +
        `\n  Start the core infra first: make up`,
    );
    process.exit(1);
  }

  const outbox = conn.collection('outbox');

  console.log(`Outbox @ ${MONGODB_URI}\n`);
  const byStatus = await outbox
    .aggregate<{ _id: string; count: number }>([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ])
    .toArray();
  const counts = new Map(byStatus.map((r) => [r._id, r.count]));
  for (const s of STATUSES) {
    console.log(`  ${s.padEnd(11)} ${counts.get(s) ?? 0}`);
  }
  for (const [s, c] of counts) {
    if (!(STATUSES as readonly string[]).includes(s)) console.log(`  ${s.padEnd(11)} ${c}  (unexpected status)`);
  }

  const stuck = await outbox
    .find({ status: { $in: ['pending', 'failed'] } })
    .sort({ createdAt: 1 })
    .limit(5)
    .toArray();

  if (stuck.length === 0) {
    console.log('\n  No pending/failed rows — relay is keeping up. ✓');
  } else {
    console.log('\n  Oldest pending/failed rows:');
    for (const row of stuck) {
      const created = row.createdAt instanceof Date ? row.createdAt : new Date(String(row.createdAt));
      console.log(
        `    [${String(row.status)}] ${String(row.topic)} ${String(row.eventType)} ` +
          `— age ${age(created)}, attempts ${String(row.attempts ?? 0)}` +
          (row.lastError ? `, lastError: ${String(row.lastError).split('\n')[0]}` : ''),
      );
    }
  }

  await conn.close();
}

main().catch((err) => {
  console.error('outbox-status failed:', err);
  process.exit(1);
});
