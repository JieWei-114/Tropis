import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Inject,
} from '@nestjs/common';
import type { Request } from 'express';
import type Redis from 'ioredis';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { ERROR_CODES } from '@tropis/shared';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis.module';
import { ApiKeyService } from './api-key.service';

/** Signed requests are valid for ±300 s around the server clock. */
export const SIGNATURE_MAX_SKEW_SECONDS = 300;

/** Nonces are remembered for the full validity window (SET NX EX 300). */
const NONCE_TTL_SECONDS = SIGNATURE_MAX_SKEW_SECONDS;
const NONCE_KEY_PREFIX = 'sig:nonce:';

/**
 * Canonical string for HMAC request signing — MUST match the SDK
 * implementation in packages/sdk/src/signing/ and the spec in
 * docs/api-conventions.md:
 *
 *   METHOD \n PATH \n X-Timestamp \n X-Nonce \n SHA256(body) as lowercase hex
 *
 * PATH is the full request path including the global prefix and query string
 * (e.g. /api/v1/track/secure), exactly as sent on the wire.
 */
export function buildCanonicalString(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: Buffer | string,
): string {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

/** hex(HMAC-SHA256(secret, canonical)) */
export function computeSignature(secret: string, canonical: string): string {
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

/**
 * Validates HMAC-signed server-to-server requests (docs/api-conventions.md).
 * Applied per-route via @RequireSignature().
 *
 * Checks, in order (all failures are 401 with a stable error code):
 *   1. all four headers present               → SIGNATURE_INVALID
 *   2. timestamp within ±300 s                → SIGNATURE_EXPIRED
 *   3. key id known                           → API_KEY_UNKNOWN
 *   4. nonce never seen (Redis SET NX EX 300) → NONCE_REUSED
 *   5. constant-time signature compare        → SIGNATURE_INVALID
 *
 * Requires the raw request bytes: main.ts configures express.json() with a
 * `verify` callback that stores the untouched body buffer on `req.rawBody`.
 */
@Injectable()
export class SignatureGuard implements CanActivate {
  constructor(
    private readonly apiKeys: ApiKeyService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { rawBody?: Buffer }>();

    const keyId = this.header(request, 'x-api-key');
    const timestamp = this.header(request, 'x-timestamp');
    const nonce = this.header(request, 'x-nonce');
    const signature = this.header(request, 'x-signature');

    if (!keyId || !timestamp || !nonce || !signature) {
      throw this.unauthorized(
        ERROR_CODES.SIGNATURE_INVALID,
        'Missing signing headers (X-Api-Key, X-Timestamp, X-Nonce, X-Signature)',
      );
    }

    // 2. Timestamp window — rejects replays outside ±300 s even if Redis
    //    has already expired the nonce.
    const ts = Number(timestamp);
    const nowSecs = Math.floor(Date.now() / 1000);
    if (
      !Number.isInteger(ts) ||
      Math.abs(nowSecs - ts) > SIGNATURE_MAX_SKEW_SECONDS
    ) {
      throw this.unauthorized(
        ERROR_CODES.SIGNATURE_EXPIRED,
        `X-Timestamp outside the ±${SIGNATURE_MAX_SKEW_SECONDS}s window`,
      );
    }

    // 3. Key lookup
    const secret = this.apiKeys.getSecret(keyId);
    if (!secret) {
      throw this.unauthorized(ERROR_CODES.API_KEY_UNKNOWN, 'Unknown API key');
    }

    // 4. Signature — recompute over the raw bytes and compare constant-time.
    //    Verified BEFORE the nonce is consumed, so a bad-signature request can't
    //    burn a legitimate nonce (which would fail the real caller's retry).
    const canonical = buildCanonicalString(
      request.method,
      request.originalUrl ?? request.url,
      timestamp,
      nonce,
      request.rawBody ?? Buffer.alloc(0),
    );
    const expected = computeSignature(secret, canonical);
    const given = Buffer.from(signature, 'utf8');
    const want = Buffer.from(expected, 'utf8');
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      throw this.unauthorized(
        ERROR_CODES.SIGNATURE_INVALID,
        'Signature verification failed',
      );
    }

    // 5. Nonce dedup — atomic SET NX EX, only after the signature is proven
    //    valid. A second VALID request with the same nonce inside the window
    //    fails (replay protection); invalid requests never reach here.
    const stored = await this.redis.set(
      `${NONCE_KEY_PREFIX}${keyId}:${nonce}`,
      '1',
      'EX',
      NONCE_TTL_SECONDS,
      'NX',
    );
    if (stored !== 'OK') {
      throw this.unauthorized(ERROR_CODES.NONCE_REUSED, 'Nonce already used');
    }

    return true;
  }

  private header(request: Request, name: string): string | undefined {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }

  private unauthorized(code: string, message: string): UnauthorizedException {
    // { code, message } is picked up by GlobalExceptionFilter and surfaced
    // in the standard error envelope.
    return new UnauthorizedException({ code, message });
  }
}
