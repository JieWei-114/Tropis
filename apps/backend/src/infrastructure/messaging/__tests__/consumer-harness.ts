import type { EventEnvelope } from '@tropis/shared';
import type { DedupPort } from '../../dedup/dedup.port';
import { runInTenant } from '../../../common/tenant/tenant.context';
import { toTenantId } from '../../../common/keyspace';
import { EventConsumer } from '../event-consumer';
import type { MessageHandler, MessagingPort } from '../messaging.port';

/** Dedup fake with real claim and owner semantics. */
export function inMemoryDedup() {
  const keys = new Map<string, string>();
  const owns = (key: string, owner?: string) =>
    keys.has(key) && (owner === undefined || keys.get(key) === owner);
  const claimMany = jest.fn(
    async (ks: readonly string[], _ttl: number, owner = '1') =>
      ks.map((key) => {
        if (keys.has(key)) return false;
        keys.set(key, owner);
        return true;
      }),
  );
  const extendMany = jest.fn(
    async (ks: readonly string[], _ttl: number, owner?: string) =>
      ks.map((key) => owns(key, owner)),
  );
  const releaseMany = jest.fn(async (ks: readonly string[], owner?: string) =>
    ks.map((key) => {
      if (!owns(key, owner)) return false;
      keys.delete(key);
      return true;
    }),
  );
  return {
    keys,
    claimMany,
    extendMany,
    releaseMany,
    claim: jest.fn(
      async (key: string, ttl: number, owner?: string) =>
        (await claimMany([key], ttl, owner))[0],
    ),
    extend: jest.fn(
      async (key: string, ttl: number, owner?: string) =>
        (await extendMany([key], ttl, owner))[0],
    ),
    release: jest.fn(
      async (key: string, owner?: string) =>
        (await releaseMany([key], owner))[0],
    ),
    health: jest.fn(),
  };
}

/**
 * A real EventConsumer over a messaging fake that captures the subscription
 * handler; deliver() hands it one decoded message inside the envelope's
 * tenant, as the adapters do.
 */
export function consumerHarness<
  D extends Pick<DedupPort, 'claimMany' | 'extendMany' | 'releaseMany'> =
    ReturnType<typeof inMemoryDedup>,
>(dedup: D = inMemoryDedup() as unknown as D) {
  let handler: MessageHandler | undefined;
  const subscribe = jest.fn(
    async (_topic: string, _sub: string, fn: MessageHandler) => {
      handler = fn;
      return { close: jest.fn() };
    },
  );
  const messaging = { subscribe } as unknown as MessagingPort;
  const consumer = new EventConsumer(messaging, dedup as unknown as DedupPort);
  const started = () => subscribe.mock.calls.length > 0;
  const deliver = (
    data: unknown,
    envelope: Partial<EventEnvelope> = {},
    tenant: string | null = 'acme',
  ): Promise<void> => {
    if (!handler) throw new Error('not subscribed');
    const full = {
      specversion: '1.0',
      id: 'env-1',
      source: '/test',
      type: 'test.thing.happened',
      time: new Date(0).toISOString(),
      datacontenttype: 'application/json',
      schemaversion: '1',
      ...envelope,
      data,
    } as EventEnvelope;
    const raw = Buffer.from(JSON.stringify(data));
    const run = () => Promise.resolve(handler!(raw, full));
    return tenant ? runInTenant(toTenantId(tenant), run) : run();
  };
  return { consumer, dedup, subscribe, deliver, started };
}
