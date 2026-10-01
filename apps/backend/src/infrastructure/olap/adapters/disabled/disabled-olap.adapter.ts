import {
  capabilityDisabled,
  CapabilityDisabledError,
  type CapabilityHealth,
} from '../../../capability';
import type { OlapPort } from '../../olap.port';

export class DisabledOlapAdapter implements OlapPort {
  insert(): Promise<void> {
    return Promise.reject(new CapabilityDisabledError('olap', 'insert'));
  }

  insertGlobal(): Promise<void> {
    return Promise.reject(new CapabilityDisabledError('olap', 'insertGlobal'));
  }

  query<T>(): Promise<T[]> {
    return Promise.reject(new CapabilityDisabledError('olap', 'query'));
  }

  queryGlobal<T>(): Promise<T[]> {
    return Promise.reject(new CapabilityDisabledError('olap', 'queryGlobal'));
  }

  health(): Promise<CapabilityHealth> {
    return Promise.resolve(capabilityDisabled());
  }
}
