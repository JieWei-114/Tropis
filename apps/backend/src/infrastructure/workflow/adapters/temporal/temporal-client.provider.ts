import type { FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, Connection } from '@temporalio/client';
import { selectAdapter } from '../../../capability';
import { WORKFLOW_ADAPTERS } from '../../workflow.port';
import { TemporalClientHolder } from './temporal-client.holder';
import { TEMPORAL_CLIENT } from './temporal.constants';
import { traceClientInterceptor } from './temporal-trace-headers';

/**
 * The Temporal client holder. Degrades instead of crash-looping: while
 * Temporal is unreachable, workflow features report unavailable and the
 * rest of the app runs; the holder reconnects once it is back. With
 * WORKFLOW_ADAPTER=disabled no connection is ever attempted.
 */
export const temporalClientProvider: FactoryProvider<
  Promise<TemporalClientHolder>
> = {
  provide: TEMPORAL_CLIENT,
  inject: [ConfigService],
  useFactory: async (config: ConfigService) => {
    const adapter = selectAdapter(
      'WORKFLOW_ADAPTER',
      config.get<string>('WORKFLOW_ADAPTER'),
      WORKFLOW_ADAPTERS,
      'temporal',
    );
    if (adapter === 'disabled') return new TemporalClientHolder(null);

    const address = config.getOrThrow<string>('TEMPORAL_ADDRESS');
    const namespace = config.getOrThrow<string>('TEMPORAL_NAMESPACE');
    const holder = new TemporalClientHolder(async () => {
      const connection = await Connection.connect({
        address,
        connectTimeout: '3s',
      });
      return new Client({
        connection,
        namespace,
        interceptors: { workflow: [traceClientInterceptor] },
      });
    });
    await holder.get();
    return holder;
  },
};
