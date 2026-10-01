import type Pulsar from 'pulsar-client';

const HEALTH_PROBE_TOPIC = 'persistent://public/default/__health_probe__';

/**
 * Pulsar has no ping. One long-lived producer on a probe topic is created on
 * the first check and reused: the check reads its connection state, so a
 * health request never opens a producer of its own. The client reconnects
 * the producer by itself after an outage.
 */
export class PulsarProbe {
  private producer: Promise<Pulsar.Producer> | null = null;

  constructor(private readonly client: Pulsar.Client) {}

  async check(): Promise<void> {
    if (!this.producer) {
      this.producer = this.client
        .createProducer({ topic: HEALTH_PROBE_TOPIC })
        .catch((err: unknown) => {
          this.producer = null;
          throw err;
        });
    }
    const producer = await this.producer;
    if (!producer.isConnected()) {
      throw new Error('Pulsar probe producer is disconnected');
    }
  }

  async close(): Promise<void> {
    const pending = this.producer;
    this.producer = null;
    await pending?.then((p) => p.close()).catch(() => undefined);
  }
}
