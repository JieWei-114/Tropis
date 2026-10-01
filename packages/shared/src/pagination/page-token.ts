/**
 * Page tokens (AIP-158). A token is opaque to clients: they pass back the
 * `next_page_token` of one response as the `page_token` of the next request
 * and never build or parse one. Servers that page by offset encode the
 * offset of the next page with these helpers.
 */

/** Default and maximum page sizes for list methods without their own. */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

const PREFIX = 'o:';

function toBase64Url(text: string): string {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(token: string): string {
  const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
  return atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

/** Opaque token for the page that starts at `offset`. */
export function encodeOffsetPageToken(offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError(`page offset must be a non-negative integer`);
  }
  return toBase64Url(`${PREFIX}${offset}`);
}

/**
 * Offset of a page token: 0 for an empty token, undefined for one this
 * server did not issue (the caller rejects it as an invalid argument).
 */
export function decodeOffsetPageToken(token: string): number | undefined {
  if (token === '') return 0;
  let text: string;
  try {
    text = fromBase64Url(token);
  } catch {
    return undefined;
  }
  if (!text.startsWith(PREFIX)) return undefined;
  const digits = text.slice(PREFIX.length);
  if (!/^\d{1,15}$/.test(digits)) return undefined;
  return Number(digits);
}

/** A requested page size clamped to [1, max]; 0 or negative selects `fallback`. */
export function resolvePageSize(
  requested: number | undefined,
  fallback = DEFAULT_PAGE_SIZE,
  max = MAX_PAGE_SIZE,
): number {
  if (!requested || requested <= 0) return Math.min(fallback, max);
  return Math.min(Math.trunc(requested), max);
}
