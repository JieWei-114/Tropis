import type { LockKey } from '../../common/keyspace';
import type { HealthCheckable } from '../capability';

/**
 * Lock — time-bounded leases for mutual exclusion across instances. A lease
 * expires on its own if the holder dies; renew and release act only while the
 * caller still owns it, so a slow holder can never extend or free a lease
 * that has meanwhile passed to someone else.
 */
export const LOCK = Symbol('LOCK');

export interface Lease {
  readonly key: LockKey;
  /** Opaque owner token; unique per acquire. */
  readonly token: string;
  /** Resets the lease to `ttlMs` if still owned; false when ownership was lost. */
  renew(ttlMs: number): Promise<boolean>;
  /** Frees the lease if still owned; false when it had expired or been taken. */
  release(): Promise<boolean>;
}

export interface LockPort extends HealthCheckable {
  /** A lease for `ttlMs`, or null when another owner holds the key. */
  acquire(key: LockKey, ttlMs: number): Promise<Lease | null>;
}

export const LOCK_ADAPTERS = ['redis', 'disabled'] as const;
export type LockAdapterName = (typeof LOCK_ADAPTERS)[number];
