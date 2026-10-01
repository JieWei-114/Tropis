import {
  capabilityDisabled,
  CapabilityDisabledError,
  type CapabilityHealth,
} from '../../../capability';
import type { Lease, LockPort } from '../../lock.port';

export class DisabledLockAdapter implements LockPort {
  acquire(): Promise<Lease | null> {
    return Promise.reject(new CapabilityDisabledError('lock', 'acquire'));
  }

  health(): Promise<CapabilityHealth> {
    return Promise.resolve(capabilityDisabled());
  }
}
