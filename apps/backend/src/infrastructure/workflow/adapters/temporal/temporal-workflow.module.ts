import { Module } from '@nestjs/common';
import { temporalClientProvider } from './temporal-client.provider';
import { TEMPORAL_CLIENT } from './temporal.constants';

/** The Temporal client, in every role (starting and reading workflows). */
@Module({
  providers: [temporalClientProvider],
  exports: [TEMPORAL_CLIENT],
})
export class TemporalWorkflowModule {}
