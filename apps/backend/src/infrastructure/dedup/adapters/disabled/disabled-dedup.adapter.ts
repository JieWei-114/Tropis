import {
  capabilityDisabled,
  CapabilityDisabledError,
  type CapabilityHealth,
} from '../../../capability';
import type { DedupPort } from '../../dedup.port';

export class DisabledDedupAdapter implements DedupPort {
  claim(): Promise<boolean> {
    return Promise.reject(new CapabilityDisabledError('dedup', 'claim'));
  }

  claimMany(): Promise<boolean[]> {
    return Promise.reject(new CapabilityDisabledError('dedup', 'claimMany'));
  }

  extend(): Promise<boolean> {
    return Promise.reject(new CapabilityDisabledError('dedup', 'extend'));
  }

  extendMany(): Promise<boolean[]> {
    return Promise.reject(new CapabilityDisabledError('dedup', 'extendMany'));
  }

  release(): Promise<boolean> {
    return Promise.reject(new CapabilityDisabledError('dedup', 'release'));
  }

  releaseMany(): Promise<boolean[]> {
    return Promise.reject(new CapabilityDisabledError('dedup', 'releaseMany'));
  }

  health(): Promise<CapabilityHealth> {
    return Promise.resolve(capabilityDisabled());
  }
}
