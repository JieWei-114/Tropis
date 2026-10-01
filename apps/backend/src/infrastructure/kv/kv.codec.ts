import { assertPositiveInteger } from '../capability';
import type { KvWriteOptions } from './kv.port';

export const KV_CODEC_VERSION = 1;

export class KvDecodeError extends Error {
  constructor(key: string) {
    super(`KV value at ${key} is not a v${KV_CODEC_VERSION} envelope`);
    this.name = 'KvDecodeError';
  }
}

export function encodeKvValue(value: unknown): string {
  if (value === undefined) {
    throw new TypeError('Cannot store undefined in kv; use del()');
  }
  return JSON.stringify({ v: KV_CODEC_VERSION, d: value });
}

export function decodeKvValue<T>(
  key: string,
  raw: string | null,
): T | undefined {
  if (raw === null) return undefined;
  let parsed: { v?: unknown; d?: unknown } | null;
  try {
    parsed = JSON.parse(raw) as { v?: unknown; d?: unknown } | null;
  } catch {
    throw new KvDecodeError(key);
  }
  if (!parsed || parsed.v !== KV_CODEC_VERSION || !('d' in parsed)) {
    throw new KvDecodeError(key);
  }
  return parsed.d as T;
}

/** The TTL in seconds, or `null` for persistent; rejects anything implicit. */
export function resolveKvLifetime(options: KvWriteOptions): number | null {
  if (options?.persistent === true && options.ttlSeconds === undefined) {
    return null;
  }
  if (options && options.persistent === undefined) {
    assertPositiveInteger(options.ttlSeconds, 'KV ttlSeconds');
    return options.ttlSeconds;
  }
  throw new TypeError(
    'KV write needs exactly one of { ttlSeconds } or { persistent: true }',
  );
}
