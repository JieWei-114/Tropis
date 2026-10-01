import { createHash } from 'crypto';

/**
 * Central redaction for log records. Keys are compared case-insensitively
 * with `-` and `_` removed, so `refresh_token`, `refreshToken` and
 * `Refresh-Token` all match.
 *
 * - credentials (authorization, cookie, password, passwordHash, token,
 *   refreshToken, secret, apiKey, and any key ending in token / secret /
 *   password) become `[redacted]`;
 * - emails (any key ending in `email`, and email addresses inside strings
 *   such as `msg`) become `sha256:<16 hex>`, which still lets two records
 *   about the same address be matched without storing the address.
 */
export const REDACTED = '[redacted]';

const EXACT_KEYS = new Set([
  'authorization',
  'cookie',
  'setcookie',
  'password',
  'passwordhash',
  'token',
  'tokens',
  'accesstoken',
  'refreshtoken',
  'secret',
  'clientsecret',
  'apikey',
  'xapikey',
  'xservicetoken',
  'xsignature',
]);
const SECRET_SUFFIXES = [
  'token',
  'secret',
  'password',
  'passwordhash',
  'apikey',
];

/** Header paths pino-http serialises, redacted by pino's fast path. */
export const REDACTED_HEADER_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-service-token"]',
  'req.headers["x-signature"]',
  'res.headers["set-cookie"]',
];

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const MAX_DEPTH = 6;

function normalise(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

export function isSecretKey(key: string): boolean {
  const k = normalise(key);
  return EXACT_KEYS.has(k) || SECRET_SUFFIXES.some((s) => k.endsWith(s));
}

export function isEmailKey(key: string): boolean {
  return normalise(key).endsWith('email');
}

export function hashEmail(email: string): string {
  const digest = createHash('sha256')
    .update(email.trim().toLowerCase())
    .digest('hex');
  return `sha256:${digest.slice(0, 16)}`;
}

/** Replaces every email address inside free text with its hash. */
export function scrubText(text: string): string {
  return text.replace(EMAIL_IN_TEXT, (m) => hashEmail(m));
}

function isPlain(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Returns a redacted copy of plain objects and arrays. Class instances
 * (requests, responses, Buffers) are returned untouched: their serialisers
 * decide what they print, and the header paths above cover them.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) {
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (!isPlain(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretKey(key)) {
      out[key] = v === undefined || v === null ? v : REDACTED;
    } else if (isEmailKey(key) && typeof v === 'string') {
      out[key] = hashEmail(v);
    } else {
      out[key] = redact(v, depth + 1);
    }
  }
  return out;
}
