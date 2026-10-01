import {
  capabilityDisabled,
  CapabilityDisabledError,
  type CapabilityHealth,
} from '../../../capability';
import type { VectorMatch, VectorPort } from '../../vector.port';

export class DisabledVectorAdapter implements VectorPort {
  upsert(): Promise<void> {
    return Promise.reject(new CapabilityDisabledError('vector', 'upsert'));
  }

  get(): Promise<number[] | null> {
    return Promise.reject(new CapabilityDisabledError('vector', 'get'));
  }

  similar(): Promise<VectorMatch[]> {
    return Promise.reject(new CapabilityDisabledError('vector', 'similar'));
  }

  delete(): Promise<void> {
    return Promise.reject(new CapabilityDisabledError('vector', 'delete'));
  }

  health(): Promise<CapabilityHealth> {
    return Promise.resolve(capabilityDisabled());
  }
}
