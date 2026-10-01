import type { DedupKey } from '../../common/keyspace';
import type { HealthCheckable } from '../capability';

/**
 * Dedup — idempotency markers and seen-sets. claim() is an atomic
 * set-if-absent: of any number of concurrent claims on one key exactly one
 * wins, and the marker vanishes after its TTL.
 *
 * A claim may name its owner (a token unique to the attempt). extend() and
 * release() given that owner act only while the marker is still the
 * owner's, so an attempt whose claim expired and was taken by another
 * cannot extend or drop the other's claim. Without an owner they act on
 * whatever marker is there.
 *
 * The *Many variants take one round trip for any number of keys and answer
 * per key, in order.
 */
export const DEDUP = Symbol('DEDUP');

export interface DedupPort extends HealthCheckable {
  /** True for the first claim of `key` within `ttlSeconds`, false after. */
  claim(key: DedupKey, ttlSeconds: number, owner?: string): Promise<boolean>;
  claimMany(
    keys: readonly DedupKey[],
    ttlSeconds: number,
    owner?: string,
  ): Promise<boolean[]>;
  /** Resets the marker's TTL; false when no marker (of `owner`) exists. */
  extend(key: DedupKey, ttlSeconds: number, owner?: string): Promise<boolean>;
  extendMany(
    keys: readonly DedupKey[],
    ttlSeconds: number,
    owner?: string,
  ): Promise<boolean[]>;
  /**
   * Drops the marker so the work may be claimed again (e.g. after a
   * failure); true when a marker (of `owner`) was dropped.
   */
  release(key: DedupKey, owner?: string): Promise<boolean>;
  releaseMany(keys: readonly DedupKey[], owner?: string): Promise<boolean[]>;
}

/** The marker value of a claim made without an owner. */
export const ANONYMOUS_OWNER = '1';

export const DEDUP_ADAPTERS = ['redis', 'disabled'] as const;
export type DedupAdapterName = (typeof DEDUP_ADAPTERS)[number];
