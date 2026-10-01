import {
  capabilityDisabled,
  CapabilityDisabledError,
  type CapabilityHealth,
} from '../../../capability';
import type { SearchPort, SearchResult } from '../../search.port';

export class DisabledSearchAdapter implements SearchPort {
  ensureIndex(): Promise<void> {
    return Promise.reject(new CapabilityDisabledError('search', 'ensureIndex'));
  }

  index(): Promise<void> {
    return Promise.reject(new CapabilityDisabledError('search', 'index'));
  }

  remove(): Promise<void> {
    return Promise.reject(new CapabilityDisabledError('search', 'remove'));
  }

  query<T>(): Promise<SearchResult<T>> {
    return Promise.reject(new CapabilityDisabledError('search', 'query'));
  }

  health(): Promise<CapabilityHealth> {
    return Promise.resolve(capabilityDisabled());
  }
}
