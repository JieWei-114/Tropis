import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PulsarBrokerAdapter } from './pulsar-broker.adapter';
import { MESSAGE_BROKER } from './message-broker.port';

/**
 * Provides MESSAGE_BROKER (the broker-agnostic MessageBrokerPort).
 *
 * The concrete adapter is selected by the MESSAGE_BROKER env var
 * (validated in config/env.validation.ts). Today only 'pulsar' exists.
 *
 * To add a Kafka adapter later:
 *   1. Implement MessageBrokerPort in kafka-broker.adapter.ts.
 *   2. Add a case to the switch below.
 *   3. Add 'kafka' to the env validation valid() list.
 * No consumer code changes required.
 */
@Global()
@Module({
  providers: [
    PulsarBrokerAdapter,
    {
      provide: MESSAGE_BROKER,
      inject: [ConfigService, PulsarBrokerAdapter],
      useFactory: (config: ConfigService, pulsar: PulsarBrokerAdapter) => {
        const broker = config.get<string>('MESSAGE_BROKER', 'pulsar');
        switch (broker) {
          case 'pulsar':
            return pulsar;
          default:
            // Unreachable in practice — env validation rejects unknown values.
            throw new Error(`Unsupported MESSAGE_BROKER: ${broker}`);
        }
      },
    },
  ],
  exports: [MESSAGE_BROKER],
})
export class MessagingModule {}
