import {
  capabilityDisabled,
  CapabilityDisabledError,
  type CapabilityHealth,
} from '../../../capability';
import type { GraphPort, GraphRecord } from '../../graph.port';

export class DisabledGraphAdapter implements GraphPort {
  read<T extends GraphRecord>(): Promise<T[]> {
    return Promise.reject(new CapabilityDisabledError('graph', 'read'));
  }

  write<T extends GraphRecord>(): Promise<T[]> {
    return Promise.reject(new CapabilityDisabledError('graph', 'write'));
  }

  mergeNode(): Promise<void> {
    return Promise.reject(new CapabilityDisabledError('graph', 'mergeNode'));
  }

  mergeEdge(): Promise<boolean> {
    return Promise.reject(new CapabilityDisabledError('graph', 'mergeEdge'));
  }

  health(): Promise<CapabilityHealth> {
    return Promise.resolve(capabilityDisabled());
  }
}
