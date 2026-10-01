import { Module } from '@nestjs/common';
import { JobsModule } from '../../jobs.module';
import {
  bullBoardEnabled,
  bullBoardImports,
  bullBoardProviders,
} from './bull-board';

const enabled = bullBoardEnabled(
  process.env.NODE_ENV,
  process.env.SERVICE_ROLE,
);

/** Bull Board, in the local `all` role outside production, for localhost only. */
@Module({
  imports: enabled ? [JobsModule.forRoot(), ...bullBoardImports(enabled)] : [],
  providers: bullBoardProviders(enabled),
})
export class BullmqDashboardModule {}
