import { Injectable, Inject } from '@nestjs/common';
import {
  HealthIndicator,
  HealthIndicatorResult,
  HealthCheckError,
} from '@nestjs/terminus';
import type Pulsar from 'pulsar-client';
import { PULSAR_CLIENT } from '../../../infrastructure/pulsar/pulsar.module';

// Deliberately injects PULSAR_CLIENT (not MESSAGE_BROKER): a health probe is
// broker-specific by nature — a Kafka adapter would ship its own indicator.
@Injectable()
export class PulsarHealthIndicator extends HealthIndicator {
  constructor(@Inject(PULSAR_CLIENT) private readonly pulsar: Pulsar.Client) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    // Pulsar has no explicit ping — we probe by creating a short-lived producer
    // on a system topic and immediately closing it. If the broker is up, this succeeds.
    let producer: Pulsar.Producer | null = null;
    try {
      producer = await this.pulsar.createProducer({
        topic: 'persistent://public/default/__health_probe__',
      });
      await producer.close();
      return this.getStatus(key, true);
    } catch (err) {
      await producer?.close().catch(() => undefined);
      const result = this.getStatus(key, false, { message: String(err) });
      throw new HealthCheckError('Pulsar unreachable', result);
    }
  }
}
