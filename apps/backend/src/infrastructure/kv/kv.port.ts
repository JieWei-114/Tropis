import type { KvKey } from '../../common/keyspace';
import type { HealthCheckable } from '../capability';

/**
 * KV — keyed state that must persist for its TTL (unlike cache, losing it is
 * a bug). A write states its lifetime explicitly: a TTL, or `persistent: true`
 * as a deliberate choice. Values are stored as versioned JSON; a value that
 * does not decode is corruption and throws KvDecodeError.
 */
export const KV = Symbol('KV');

export type KvWriteOptions =
  | { ttlSeconds: number; persistent?: never }
  | { persistent: true; ttlSeconds?: never };

export interface KvPort extends HealthCheckable {
  get<T>(key: KvKey): Promise<T | undefined>;
  /** Overwrites the value and its lifetime; `persistent` clears any TTL. */
  set<T>(key: KvKey, value: T, options: KvWriteOptions): Promise<void>;
  /** Resolves true when a value was removed. */
  del(key: KvKey): Promise<boolean>;
  exists(key: KvKey): Promise<boolean>;
}

export const KV_ADAPTERS = ['redis', 'aerospike', 'disabled'] as const;
export type KvAdapterName = (typeof KV_ADAPTERS)[number];
