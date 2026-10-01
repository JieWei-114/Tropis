import {
  capabilityDisabled,
  CapabilityDisabledError,
  type CapabilityHealth,
} from '../../../capability';
import type { ObjectsPort, StoredObject } from '../../objects.port';

export class DisabledObjectsAdapter implements ObjectsPort {
  put(): Promise<StoredObject> {
    return Promise.reject(new CapabilityDisabledError('objects', 'put'));
  }

  presignedGet(): Promise<string> {
    return Promise.reject(
      new CapabilityDisabledError('objects', 'presignedGet'),
    );
  }

  delete(): Promise<void> {
    return Promise.reject(new CapabilityDisabledError('objects', 'delete'));
  }

  health(): Promise<CapabilityHealth> {
    return Promise.resolve(capabilityDisabled());
  }
}
