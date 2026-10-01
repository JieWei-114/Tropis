/**
 * Cache value envelope: `{"v":1,"d":<value>}`. The version lets the envelope
 * change later without misreading values written by an older release; any
 * value that does not decode is treated as a miss.
 */
export const CACHE_CODEC_VERSION = 1;

interface Envelope {
  v: number;
  d: unknown;
}

export function encodeCacheValue(value: unknown): string {
  if (value === undefined) {
    throw new TypeError('Cannot cache undefined; cache null instead');
  }
  return JSON.stringify({
    v: CACHE_CODEC_VERSION,
    d: value,
  } satisfies Envelope);
}

export function decodeCacheValue<T>(raw: string | null): T | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<Envelope> | null;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.v !== CACHE_CODEC_VERSION ||
      !('d' in parsed)
    ) {
      return undefined;
    }
    return parsed.d as T;
  } catch {
    return undefined;
  }
}
