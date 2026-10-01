import type { Readable } from 'stream';
import { isTenantId, type TenantId } from '../../common/keyspace';
import type { HealthCheckable } from '../capability';

/**
 * Objects — S3-API blob storage in one configured bucket. Every object
 * belongs to one tenant: each method takes the TenantId and the adapter
 * stores the caller's key under `t.<tenantId>/`, so a key can never reach
 * another tenant's objects. Keys are `/`-separated relative paths chosen by
 * the caller (never user input verbatim); `..` segments are rejected.
 */
export const OBJECTS = Symbol('OBJECTS');

export class InvalidObjectKeyError extends Error {
  constructor(key: string) {
    super(`Invalid object key ${JSON.stringify(key)}`);
    this.name = 'InvalidObjectKeyError';
  }
}

/** The bucket key of a tenant's object: `t.<tenantId>/<key>`. */
export function tenantObjectKey(tenantId: TenantId, key: string): string {
  if (!isTenantId(tenantId)) {
    throw new InvalidObjectKeyError(`${String(tenantId)}/${key}`);
  }
  if (
    !key ||
    key.startsWith('/') ||
    key.split('/').some((part) => part === '..' || part === '')
  ) {
    throw new InvalidObjectKeyError(key);
  }
  return `t.${tenantId}/${key}`;
}

export interface StoredObject {
  bucket: string;
  /** The caller's key, without the tenant prefix. */
  key: string;
}

export interface PresignedGetOptions {
  contentDisposition?: string;
}

export interface ObjectsPort extends HealthCheckable {
  /** Stores `size` bytes under the tenant's `key`, replacing any existing object. */
  put(
    tenantId: TenantId,
    key: string,
    data: Buffer | Readable,
    size: number,
    contentType?: string,
  ): Promise<StoredObject>;
  /** A time-limited GET URL for the tenant's `key`. */
  /**
   * A time-limited GET URL. `contentDisposition` is the Content-Disposition
   * the store answers that GET with (e.g. `attachment`), so a user upload
   * opened directly is downloaded rather than rendered by the browser.
   */
  presignedGet(
    tenantId: TenantId,
    key: string,
    expirySeconds: number,
    options?: PresignedGetOptions,
  ): Promise<string>;
  /** Removes the tenant's `key`; removing an absent key succeeds. */
  delete(tenantId: TenantId, key: string): Promise<void>;
}

export const OBJECTS_ADAPTERS = ['minio', 'disabled'] as const;
export type ObjectsAdapterName = (typeof OBJECTS_ADAPTERS)[number];
