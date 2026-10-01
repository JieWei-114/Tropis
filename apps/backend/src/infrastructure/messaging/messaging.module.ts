import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Pulsar from 'pulsar-client';
import { selectAdapter } from '../capability';
import { importWhenSelected } from '../capability/conditional-import';
import {
  PULSAR_CLIENT,
  PulsarConnectionModule,
} from '../connections/pulsar/pulsar-connection.module';
import { DedupModule } from '../dedup/dedup.module';
import { DisabledMessagingAdapter } from './adapters/disabled/disabled-messaging.adapter';
import { KafkaMessagingAdapter } from './adapters/kafka/kafka-messaging.adapter';
import { PulsarMessagingAdapter } from './adapters/pulsar/pulsar-messaging.adapter';
import { ConsumersHealthIndicator } from './consumers.health';
import { EventConsumer } from './event-consumer';
import { MessagingHealthIndicator } from './messaging.health';
import {
  DEFAULT_REDELIVERY,
  MESSAGING,
  MESSAGING_ADAPTERS,
  type MessagingAdapter,
  type RedeliveryOptions,
} from './messaging.port';

function redeliveryFrom(config: ConfigService): RedeliveryOptions {
  return {
    maxRedeliveries: Number(
      config.get<number>(
        'MESSAGING_MAX_REDELIVERIES',
        DEFAULT_REDELIVERY.maxRedeliveries,
      ),
    ),
    redeliveryDelayMs: Number(
      config.get<number>(
        'MESSAGING_REDELIVERY_DELAY_MS',
        DEFAULT_REDELIVERY.redeliveryDelayMs,
      ),
    ),
    maxRedeliveryDelayMs: Number(
      config.get<number>(
        'MESSAGING_MAX_REDELIVERY_DELAY_MS',
        DEFAULT_REDELIVERY.maxRedeliveryDelayMs!,
      ),
    ),
  };
}

/**
 * Provides MESSAGING (MessagingPort) and EventConsumer, adapter chosen by
 * MESSAGING_ADAPTER: `pulsar` (default) reuses PULSAR_CLIENT, which is
 * opened only when Pulsar is selected; `kafka` owns its own kafkajs client
 * (KAFKA_BROKERS, KAFKA_CLIENT_ID); `disabled` rejects publish/subscribe.
 * Redelivery comes from MESSAGING_MAX_REDELIVERIES,
 * MESSAGING_REDELIVERY_DELAY_MS and MESSAGING_MAX_REDELIVERY_DELAY_MS.
 */
@Module({})
export class MessagingModule {
  private static root?: DynamicModule;

  static forRoot(): DynamicModule {
    return (MessagingModule.root ??= {
      module: MessagingModule,
      imports: [
        importWhenSelected(
          'MESSAGING_ADAPTER',
          'pulsar',
          'pulsar',
          PulsarConnectionModule,
        ),
        DedupModule.forRoot(),
      ],
      providers: [
        {
          provide: MESSAGING,
          inject: [ConfigService, { token: PULSAR_CLIENT, optional: true }],
          useFactory: (
            config: ConfigService,
            pulsar?: Pulsar.Client,
          ): MessagingAdapter => {
            const adapter = selectAdapter(
              'MESSAGING_ADAPTER',
              config.get<string>('MESSAGING_ADAPTER'),
              MESSAGING_ADAPTERS,
              'pulsar',
            );
            switch (adapter) {
              case 'disabled':
                return new DisabledMessagingAdapter();
              case 'kafka':
                return new KafkaMessagingAdapter({
                  brokers: config
                    .getOrThrow<string>('KAFKA_BROKERS')
                    .split(',')
                    .map((b) => b.trim())
                    .filter(Boolean),
                  clientId: config.getOrThrow<string>('KAFKA_CLIENT_ID'),
                  redelivery: redeliveryFrom(config),
                });
              case 'pulsar':
                if (!pulsar) {
                  throw new Error(
                    'MESSAGING_ADAPTER=pulsar requires PulsarConnectionModule',
                  );
                }
                return new PulsarMessagingAdapter(
                  pulsar,
                  redeliveryFrom(config),
                );
            }
          },
        },
        EventConsumer,
        MessagingHealthIndicator,
        ConsumersHealthIndicator,
      ],
      exports: [
        MESSAGING,
        EventConsumer,
        MessagingHealthIndicator,
        ConsumersHealthIndicator,
      ],
    });
  }
}
