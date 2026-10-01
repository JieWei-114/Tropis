import {
  sleep,
  uniqueId,
} from '../../capability/__tests__/conformance-helpers';
import {
  deadLetterSubscription,
  deadLetterTopic,
  redeliveryDelay,
  type MessagingAdapter,
  type MessageSubscription,
  type RedeliveryOptions,
} from '../messaging.port';

export interface MessagingConformanceTarget {
  /** Redelivery policy the adapter under test was built with. */
  redelivery: RedeliveryOptions;
  make(): Promise<MessagingAdapter> | MessagingAdapter;
  teardown?(broker: MessagingAdapter): Promise<void> | void;
  /** How long to wait for an expected delivery. */
  deliveryTimeoutMs?: number;
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** Behaviour every MessagingPort adapter must share. */
export function describeMessagingPort(
  adapter: string,
  target: MessagingConformanceTarget,
): void {
  describe(`MessagingPort conformance: ${adapter}`, () => {
    let broker: MessagingAdapter;
    const open: MessageSubscription[] = [];
    const timeout = target.deliveryTimeoutMs ?? 5_000;
    const { maxRedeliveries, redeliveryDelayMs } = target.redelivery;
    const budgetMs = Array.from({ length: maxRedeliveries + 1 }, (_, i) =>
      redeliveryDelay(target.redelivery, i),
    ).reduce((a, b) => a + b, 0);
    const newTopic = () =>
      `persistent://public/default/conformance-${uniqueId().slice(0, 12)}`;

    const subscribe = async (
      ...args: Parameters<MessagingAdapter['subscribe']>
    ) => {
      const sub = await broker.subscribe(...args);
      open.push(sub);
      return sub;
    };

    beforeAll(async () => {
      broker = await target.make();
    });

    afterEach(async () => {
      await Promise.all(open.splice(0).map((s) => s.close()));
    });

    afterAll(async () => {
      await broker.close();
      await target.teardown?.(broker);
    });

    it('reports up', async () => {
      expect((await broker.health()).status).toBe('up');
    });

    it('delivers JSON objects and raw buffers to a subscriber', async () => {
      const topic = newTopic();
      const received: Buffer[] = [];
      await subscribe(topic, 'reader', (data) => {
        received.push(data);
      });
      await broker.publish(topic, { hello: 'world' });
      await broker.publish(topic, Buffer.from([0, 1, 2]), {
        properties: { source: 'conformance' },
      });
      await waitFor(() => received.length === 2, timeout, 'two messages');
      expect(JSON.parse(received[0].toString())).toEqual({ hello: 'world' });
      expect([...received[1]]).toEqual([0, 1, 2]);
    });

    it('does not redeliver an acked message', async () => {
      const topic = newTopic();
      let calls = 0;
      await subscribe(topic, 'reader', () => {
        calls += 1;
      });
      await broker.publish(topic, { n: 1 });
      await waitFor(() => calls === 1, timeout, 'first delivery');
      await sleep(redeliveryDelayMs * 2 + 500);
      expect(calls).toBe(1);
    });

    it('redelivers a nacked message after a delay', async () => {
      const topic = newTopic();
      const seen: number[] = [];
      await subscribe(topic, 'reader', () => {
        seen.push(Date.now());
        if (seen.length === 1) throw new Error('transient');
      });
      await broker.publish(topic, { n: 1 });
      await waitFor(
        () => seen.length === 2,
        timeout + redeliveryDelayMs * 2,
        'redelivery',
      );
      expect(seen[1] - seen[0]).toBeGreaterThanOrEqual(redeliveryDelayMs * 0.8);
      await sleep(redeliveryDelayMs * 2);
      expect(seen).toHaveLength(2);
    });

    it('dead-letters a message that keeps failing', async () => {
      const topic = newTopic();
      let attempts = 0;
      const dead: Buffer[] = [];
      await subscribe(deadLetterTopic(topic), 'dlq-reader', (data) => {
        dead.push(data);
      });
      await subscribe(topic, 'reader', () => {
        attempts += 1;
        throw new Error('poison');
      });
      await broker.publish(topic, { poison: true });
      await waitFor(
        () => dead.length === 1,
        timeout + budgetMs,
        'dead-lettered message',
      );
      expect(JSON.parse(dead[0].toString())).toEqual({ poison: true });
      expect(attempts).toBeGreaterThanOrEqual(maxRedeliveries);
      expect(attempts).toBeLessThanOrEqual(maxRedeliveries + 1);
      await sleep(redeliveryDelayMs * 2);
      expect(dead).toHaveLength(1);
    });

    it('keeps dead-lettered messages for the dead-letter subscription', async () => {
      const topic = newTopic();
      let attempts = 0;
      await subscribe(topic, 'keeper', () => {
        attempts += 1;
        throw new Error('poison');
      });
      await broker.publish(topic, { kept: true });
      await waitFor(
        () => attempts >= maxRedeliveries + 1,
        timeout + budgetMs,
        'every attempt',
      );
      await sleep(redeliveryDelayMs + 1_000);
      const dead: Buffer[] = [];
      await subscribe(
        deadLetterTopic(topic),
        deadLetterSubscription('keeper'),
        (data) => {
          dead.push(data);
        },
      );
      await waitFor(() => dead.length === 1, timeout, 'retained dead letter');
      expect(JSON.parse(dead[0].toString())).toEqual({ kept: true });
    });

    if (
      (target.redelivery.maxRedeliveryDelayMs ?? 0) >
        target.redelivery.redeliveryDelayMs &&
      maxRedeliveries >= 2
    ) {
      it('doubles the delay between redeliveries', async () => {
        const topic = newTopic();
        const seen: number[] = [];
        await subscribe(topic, 'backoff', () => {
          seen.push(Date.now());
          if (seen.length <= 2) throw new Error('transient');
        });
        await broker.publish(topic, { n: 1 });
        await waitFor(
          () => seen.length === 3,
          timeout + budgetMs,
          'two redeliveries',
        );
        const first = seen[1] - seen[0];
        const second = seen[2] - seen[1];
        expect(first).toBeGreaterThanOrEqual(redeliveryDelayMs * 0.8);
        expect(second).toBeGreaterThanOrEqual(
          redeliveryDelay(target.redelivery, 1) * 0.8,
        );
      });
    }

    it('fans out across subscriptions and shares within one', async () => {
      const topic = newTopic();
      const a: string[] = [];
      const b1: string[] = [];
      const b2: string[] = [];
      await subscribe(topic, 'group-a', (d) => {
        a.push(d.toString());
      });
      await subscribe(topic, 'group-b', (d) => {
        b1.push(d.toString());
      });
      await subscribe(topic, 'group-b', (d) => {
        b2.push(d.toString());
      });
      const sent = Array.from({ length: 10 }, (_, i) => JSON.stringify({ i }));
      for (const m of sent)
        await broker.publish(topic, JSON.parse(m) as object);
      await waitFor(
        () => a.length === 10 && b1.length + b2.length === 10,
        timeout * 2,
        'fan-out',
      );
      expect(a.sort()).toEqual([...sent].sort());
      expect([...b1, ...b2].sort()).toEqual([...sent].sort());
    });

    it('keeps each key on one key_shared consumer, in publish order', async () => {
      const topic = newTopic();
      const seen: Array<Array<{ k: string; i: number }>> = [[], []];
      for (const bucket of seen) {
        await subscribe(
          topic,
          'keyed',
          (d) => {
            bucket.push(JSON.parse(d.toString()) as { k: string; i: number });
          },
          { type: 'key_shared' },
        );
      }
      const keys = ['k1', 'k2', 'k3', 'k4'];
      for (let i = 0; i < 5; i += 1) {
        for (const k of keys) await broker.publish(topic, { k, i }, { key: k });
      }
      await waitFor(
        () => seen[0].length + seen[1].length === 20,
        timeout * 2,
        'keyed delivery',
      );
      for (const k of keys) {
        const holders = seen.filter((b) => b.some((m) => m.k === k));
        expect(holders).toHaveLength(1);
        expect(holders[0].filter((m) => m.k === k).map((m) => m.i)).toEqual([
          0, 1, 2, 3, 4,
        ]);
      }
    });

    it('stops delivering after close', async () => {
      const topic = newTopic();
      const received: Buffer[] = [];
      const sub = await broker.subscribe(topic, 'reader', (d) => {
        received.push(d);
      });
      await broker.publish(topic, { n: 1 });
      await waitFor(() => received.length === 1, timeout, 'first message');
      await sub.close();
      await broker.publish(topic, { n: 2 });
      await sleep(1_000);
      expect(received).toHaveLength(1);
    });
  });
}
