/**
 * Operator actions on a Pulsar dead-letter topic (src/infrastructure/messaging).
 * A message that fails every redelivery goes to `<topic>-DLQ`, where the
 * subscription `<subscription>-DLQ` keeps it. Talks to the Pulsar admin and
 * REST APIs (PULSAR_ADMIN_URL, default http://localhost:8080):
 *
 *   list     TOPIC=<topic> SUB=<subscription>   the kept messages, oldest first
 *   redrive  TOPIC=<topic> SUB=<subscription>   publish the oldest kept
 *            [COUNT=<n>]                        message(s) to <topic> again,
 *                                               with their properties and key,
 *                                               then drop them from the DLQ
 *
 * Every consumer dedups on the event id the message carries, so a redrive
 * of an event that was handled after all changes nothing.
 *
 * Run: `TOPIC=user-events SUB=user-events-sub pnpm --filter @tropis/devtools messaging-dlq list`
 */
import * as path from 'path';
import { config } from 'dotenv';

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

const ADMIN = (process.env.PULSAR_ADMIN_URL ?? 'http://localhost:8080').replace(
  /\/$/,
  '',
);
const NAMESPACE = 'public/default';

interface Kept {
  position: number;
  payload: Buffer;
  properties: Record<string, string>;
  key?: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Pass ${name}=<value>`);
  return value;
}

function topicPath(topic: string): string {
  const name = topic.replace(/^persistent:\/\/[^/]+\/[^/]+\//, '');
  return `persistent/${NAMESPACE}/${encodeURIComponent(name)}`;
}

/** The kept message at `position` (1 = oldest), or null past the end. */
async function peek(
  dlq: string,
  sub: string,
  position: number,
): Promise<Kept | null> {
  const res = await fetch(
    `${ADMIN}/admin/v2/${topicPath(dlq)}/subscription/${encodeURIComponent(sub)}/position/${position}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`peek failed: HTTP ${res.status} ${await res.text()}`);
  }
  const properties: Record<string, string> = {};
  const raw = res.headers.get('x-pulsar-property');
  if (raw) Object.assign(properties, JSON.parse(raw) as object);
  for (const [header, value] of res.headers) {
    const match = /^x-pulsar-property-(.+)$/.exec(header);
    if (match) properties[match[1]] = value;
  }
  const key = res.headers.get('x-pulsar-partition-key') ?? undefined;
  return {
    position,
    payload: Buffer.from(await res.arrayBuffer()),
    properties,
    key,
  };
}

async function list(topic: string, sub: string): Promise<void> {
  const dlq = `${topic}-DLQ`;
  let shown = 0;
  for (let position = 1; position <= 50; position += 1) {
    const kept = await peek(dlq, `${sub}-DLQ`, position);
    if (!kept) break;
    shown += 1;
    console.log(
      `#${position}  id ${kept.properties.ce_id ?? '-'}  type ${kept.properties.ce_type ?? '-'}` +
        `  tenant ${kept.properties.ce_tenantid ?? '-'}  ${kept.payload.toString('utf8').slice(0, 120)}`,
    );
  }
  if (shown === 0) console.log(`No messages kept on ${dlq} for ${sub}-DLQ.`);
}

async function publish(topic: string, kept: Kept): Promise<void> {
  const properties = { ...kept.properties };
  // Pulsar adds these on dead-lettering; the redriven message starts afresh.
  delete properties.REAL_TOPIC;
  delete properties.ORIGIN_MESSAGE_ID;
  // The REST producer takes the payload as text; a body that is not UTF-8
  // would not survive it.
  const text = kept.payload.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(kept.payload)) {
    throw new Error(
      `message #${kept.position} is binary; redrive it with a Pulsar client`,
    );
  }
  const res = await fetch(`${ADMIN}/topics/${topicPath(topic)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [
        {
          payload: text,
          properties,
          ...(kept.key ? { key: kept.key } : {}),
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`publish failed: HTTP ${res.status} ${await res.text()}`);
  }
}

async function redrive(topic: string, sub: string, count: number) {
  const dlq = `${topic}-DLQ`;
  const dlqSub = `${sub}-DLQ`;
  let moved = 0;
  for (; moved < count; moved += 1) {
    const kept = await peek(dlq, dlqSub, 1);
    if (!kept) break;
    await publish(topic, kept);
    const res = await fetch(
      `${ADMIN}/admin/v2/${topicPath(dlq)}/subscription/${encodeURIComponent(dlqSub)}/skip/1`,
      { method: 'POST' },
    );
    if (!res.ok) {
      throw new Error(
        `published to ${topic} but not dropped from ${dlq}: HTTP ${res.status}`,
      );
    }
  }
  console.log(`Redrove ${moved} message(s) from ${dlq} to ${topic}.`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'list';
  const topic = required('TOPIC');
  const sub = required('SUB');
  if (command === 'list') return list(topic, sub);
  if (command === 'redrive') {
    const count = Number(process.env.COUNT ?? 1);
    if (!Number.isInteger(count) || count < 1) {
      throw new Error('COUNT must be a positive integer');
    }
    return redrive(topic, sub, count);
  }
  throw new Error(`Unknown command ${command}: use list or redrive`);
}

main().catch((err) => {
  console.error(
    `messaging-dlq failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
