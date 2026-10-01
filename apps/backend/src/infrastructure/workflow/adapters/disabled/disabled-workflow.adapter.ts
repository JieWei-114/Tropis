import {
  capabilityDisabled,
  CapabilityDisabledError,
  type CapabilityHealth,
} from '../../../capability';
import type { WorkflowExecution, WorkflowPort } from '../../workflow.port';

export class DisabledWorkflowAdapter implements WorkflowPort {
  isAvailable(): boolean {
    return false;
  }

  start(): Promise<{ workflowId: string }> {
    return Promise.reject(new CapabilityDisabledError('workflow', 'start'));
  }

  describe(): Promise<WorkflowExecution | null> {
    return Promise.reject(new CapabilityDisabledError('workflow', 'describe'));
  }

  count(): Promise<number> {
    return Promise.reject(new CapabilityDisabledError('workflow', 'count'));
  }

  list(): Promise<WorkflowExecution[]> {
    return Promise.reject(new CapabilityDisabledError('workflow', 'list'));
  }

  health(): Promise<CapabilityHealth> {
    return Promise.resolve(capabilityDisabled());
  }
}
