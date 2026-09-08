import { Module } from '@nestjs/common';
import { WorkflowsController } from './workflows.controller';

/**
 * Exposes read-only onboarding-workflow data. TemporalService comes from the
 * global TemporalModule, so no imports are needed here.
 */
@Module({
  controllers: [WorkflowsController],
})
export class WorkflowsModule {}
