import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createLogger } from '../../../common/observability/logger';
import {
  EventConsumer,
  type ConsumerHandle,
} from '../../../infrastructure/messaging/event-consumer';
import {
  ANALYTICS_EVENT_SEEN,
  ANALYTICS_SUBSCRIPTION,
  ANALYTICS_TOPIC,
} from '../constants/analytics.constants';
import type { IEventLog } from '../interfaces/analytics.interface';
import { AnalyticsSinkService } from '../services/analytics-sink.service';

/** STREAM_ENGINE value under which this processor owns OLAP writes. */
const NODE_ENGINE = 'node';

/**
 * Writes each analytics event into OLAP when STREAM_ENGINE=node. Exactly one
 * engine owns that table: under STREAM_ENGINE=flink this processor does not
 * subscribe and the Flink job (services/flink) writes instead, because OLAP
 * MergeTree tables do not deduplicate and two writers would double every
 * count. Dedup is on the domain eventId.
 */
@Injectable()
export class AnalyticsProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('analytics');
  private subscription: ConsumerHandle | null = null;

  constructor(
    private readonly consumer: EventConsumer,
    private readonly sink: AnalyticsSinkService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const engine = this.config.get<string>('STREAM_ENGINE');
    if (engine !== NODE_ENGINE) {
      this.logger.info(
        'olap-writer-external',
        'Analytics events are written to OLAP by another stream engine; not subscribing',
        { 'stream.engine': engine },
      );
      return;
    }
    this.subscription = this.consumer.start<IEventLog>({
      topic: ANALYTICS_TOPIC,
      subscription: ANALYTICS_SUBSCRIPTION,
      module: 'analytics',
      handle: async ({ data, envelope, tenantId }) => {
        if (!data.eventId) {
          this.logger.warn(
            'event-id-missing',
            'Message carries no eventId; dropped',
            { 'cloudevents.event_id': envelope.id },
          );
          return;
        }
        const fresh = await this.consumer.once(
          ANALYTICS_EVENT_SEEN.global(data.eventId),
          () => this.sink.store(tenantId, data),
        );
        if (fresh) await this.sink.publishLive(tenantId, data);
      },
    });
  }

  async onModuleDestroy() {
    await this.subscription?.close();
  }
}
