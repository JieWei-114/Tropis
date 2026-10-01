import { randomUUID } from 'crypto';
import { toTenantId, type KeyspaceSettings } from '../../../common/keyspace';

export const TENANT_A = toTenantId('tenant-a');
export const TENANT_B = toTenantId('tenant-b');

export const KEYSPACE_PROD: KeyspaceSettings = {
  app: 'conformance',
  env: 'prod',
};
export const KEYSPACE_STAGING: KeyspaceSettings = {
  app: 'conformance',
  env: 'staging',
};

export const uniqueId = (): string => randomUUID();

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Setup hook shared by every conformance suite. */
export interface ConformanceTarget<P> {
  make(): Promise<P> | P;
  teardown?(port: P): Promise<void> | void;
}
