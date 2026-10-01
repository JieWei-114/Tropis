import { Inject, Injectable } from '@nestjs/common';
import { CapabilityHealthIndicator } from '../capability';
import { WORKFLOW, type WorkflowPort } from './workflow.port';

@Injectable()
export class WorkflowHealthIndicator extends CapabilityHealthIndicator {
  constructor(@Inject(WORKFLOW) workflow: WorkflowPort) {
    super('workflow', workflow);
  }
}
