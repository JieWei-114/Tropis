import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Pulsar from 'pulsar-client';

export const PULSAR_CLIENT = 'PULSAR_CLIENT';

let client: Pulsar.Client | null = null;

@Global()
@Module({
  providers: [
    {
      provide: PULSAR_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        client = new Pulsar.Client({
          serviceUrl: config.get<string>(
            'PULSAR_SERVICE_URL',
            'pulsar://localhost:6650',
          ),
        });
        return client;
      },
    },
  ],
  exports: [PULSAR_CLIENT],
})
export class PulsarModule {}

// Graceful shutdown — called from main.ts before app.close()
export async function closePulsarClient() {
  if (client) await client.close();
}
