import {
  capabilityDisabled,
  CapabilityDisabledError,
  type CapabilityHealth,
} from '../../../capability';
import type { KvPort } from '../../kv.port';

export class DisabledKvAdapter implements KvPort {
  get<T>(): Promise<T | undefined> {
    return Promise.reject(new CapabilityDisabledError('kv', 'get'));
  }

  set(): Promise<void> {
    return Promise.reject(new CapabilityDisabledError('kv', 'set'));
  }

  del(): Promise<boolean> {
    return Promise.reject(new CapabilityDisabledError('kv', 'del'));
  }

  exists(): Promise<boolean> {
    return Promise.reject(new CapabilityDisabledError('kv', 'exists'));
  }

  health(): Promise<CapabilityHealth> {
    return Promise.resolve(capabilityDisabled());
  }
}
