import { capabilityUp, type CapabilityHealth } from '../../capability';
import {
  deadLetterSubscription,
  deadLetterTopic,
  DEFAULT_REDELIVERY,
  redeliveryDelay,
  type MessagingAdapter,
  type MessageHandler,
  type MessageSubscription,
  type PublishOptions,
  type RedeliveryOptions,
  type SubscribeOptions,
} from '../messaging.port';
import { consumeEnveloped, publishEnveloped } from '../messaging.envelope';

interface Member {
  handler: MessageHandler;
  open: boolean;
  keyShared: boolean;
}

interface Subscription {
  members: Member[];
  /** Messages that arrived while no member was open, kept like a broker does. */
  backlog: Delivery[];
}

interface Delivery {
  data: Buffer;
  properties: Record<string, string>;
  key?: string;
}

function hashKey(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * In-process broker with the port's delivery contract, for unit tests. It
 * goes through the same envelope and trace propagation as the real adapters,
 * so messages carry their properties from publish to consume.
 */
export class InMemoryBroker implements MessagingAdapter {
  /** topic → subscription → competing members and retained backlog */
  private readonly topics = new Map<string, Map<string, Subscription>>();
  private readonly cursor = new Map<string, number>();
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly redelivery: RedeliveryOptions = DEFAULT_REDELIVERY,
  ) {}

  /** Every message published, as it went on the wire. */
  readonly sent: Array<Delivery & { topic: string }> = [];

  publish(
    topic: string,
    payload: Buffer | object,
    opts?: PublishOptions,
  ): Promise<void> {
    return publishEnveloped('memory', topic, payload, opts, (message) => {
      this.route(topic, {
        data: message.data,
        properties: message.properties,
        key: opts?.key,
      });
      return Promise.resolve();
    });
  }

  private route(topic: string, delivery: Delivery): void {
    this.sent.push({ topic, ...delivery });
    for (const [name, sub] of this.topics.get(topic) ?? []) {
      this.deliver(topic, name, sub, delivery, 0);
    }
  }

  private subscriptionOf(topic: string, name: string): Subscription {
    const subs = this.topics.get(topic) ?? new Map<string, Subscription>();
    this.topics.set(topic, subs);
    let sub = subs.get(name);
    if (!sub) {
      sub = { members: [], backlog: [] };
      subs.set(name, sub);
    }
    return sub;
  }

  subscribe(
    topic: string,
    subscription: string,
    handler: MessageHandler,
    opts?: SubscribeOptions,
  ): Promise<MessageSubscription> {
    const sub = this.subscriptionOf(topic, subscription);
    this.subscriptionOf(
      deadLetterTopic(topic),
      deadLetterSubscription(subscription),
    );
    const members = sub.members;
    const member: Member = {
      handler,
      open: true,
      keyShared: opts?.type === 'key_shared',
    };
    members.push(member);
    for (const delivery of sub.backlog.splice(0)) {
      this.deliver(topic, subscription, sub, delivery, 0);
    }
    return Promise.resolve({
      close: () => {
        member.open = false;
        members.splice(members.indexOf(member), 1);
        return Promise.resolve();
      },
    });
  }

  close(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.topics.clear();
    return Promise.resolve();
  }

  health(): Promise<CapabilityHealth> {
    return Promise.resolve(capabilityUp('memory'));
  }

  private deliver(
    topic: string,
    subscription: string,
    sub: Subscription,
    delivery: Delivery,
    redeliveries: number,
  ): void {
    const open = sub.members.filter((m) => m.open);
    if (open.length === 0) {
      sub.backlog.push(delivery);
      return;
    }
    let member: Member;
    if (delivery.key !== undefined && open[0].keyShared) {
      member = open[hashKey(delivery.key) % open.length];
    } else {
      const key = `${topic}\0${subscription}`;
      const next = (this.cursor.get(key) ?? 0) % open.length;
      this.cursor.set(key, next + 1);
      member = open[next];
    }
    void (async () => {
      try {
        await consumeEnveloped(
          'memory',
          topic,
          subscription,
          delivery.data,
          delivery.properties,
          member.handler,
        );
      } catch {
        if (redeliveries >= this.redelivery.maxRedeliveries) {
          this.route(deadLetterTopic(topic), delivery);
          return;
        }
        const timer = setTimeout(
          () => {
            this.timers.delete(timer);
            this.deliver(topic, subscription, sub, delivery, redeliveries + 1);
          },
          redeliveryDelay(this.redelivery, redeliveries),
        );
        this.timers.add(timer);
      }
    })();
  }
}
