import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Inject,
} from '@nestjs/common';
import type { Request } from 'express';
import { ERROR_CODES, type ErrorCode } from '@tropis/shared';
import { AppError } from '../errors/app-error';
import type { TenantId } from '../keyspace';
import { DEDUP, type DedupPort } from '../../infrastructure/dedup/dedup.port';
import {
  SIGNING,
  type SigningPort,
} from '../../infrastructure/signing/signing.port';
import { ApiKeyService } from './api-key.service';
import {
  TENANT_DIRECTORY,
  assertTenantActive,
  type TenantDirectory,
} from '../tenant/tenant-directory.port';
import { isAppError } from '../errors/app-error';
import {
  TENANT_HEADER,
  TENANT_QUERY_PARAM,
  type TenantResolvedRequest,
} from '../tenant/tenant.middleware';
import {
  NONCE_TTL_SECONDS,
  SIGNATURE_MAX_SKEW_SECONDS,
  SIGNATURE_NONCE_KEY,
} from './signature.constants';

// The canonical-string builder lives with the signing capability; re-exported
// here because the SDK and native-service test vectors cite this file.
export {
  buildCanonicalString,
  computeSignature,
} from '../../infrastructure/signing/signing.canonical';

/**
 * Validates HMAC-signed server-to-server requests (docs/api-conventions.md).
 * Applied per-route via @RequireSignature().
 *
 * Checks, in order (all failures are 401 with a stable error code):
 *   1. all four headers present               → SIGNATURE_INVALID
 *   2. timestamp within ±300 s                → SIGNATURE_EXPIRED
 *   3. key id known                           → API_KEY_UNKNOWN
 *   4. constant-time signature compare        → SIGNATURE_INVALID
 *      (signing port: in-process or native service)
 *   5. a tenant hint, if sent, names the key's
 *      tenant (403)                           → TENANT_MISMATCH
 *   6. the key's tenant is registered and
 *      active (404 / 403)                     → TENANT_NOT_FOUND / TENANT_INACTIVE
 *   7. nonce never seen (dedup claim, 300 s)  → NONCE_REUSED
 *
 * The request then runs in the tenant the API key is bound to; an unsigned
 * header can never choose it.
 *
 * Requires the raw request bytes: main.ts configures express.json() with a
 * `verify` callback that stores the untouched body buffer on `req.rawBody`.
 */
@Injectable()
export class SignatureGuard implements CanActivate {
  constructor(
    private readonly apiKeys: ApiKeyService,
    @Inject(SIGNING) private readonly signing: SigningPort,
    @Inject(DEDUP) private readonly dedup: DedupPort,
    @Inject(TENANT_DIRECTORY)
    private readonly tenants: Pick<TenantDirectory, 'find'>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & TenantResolvedRequest & { rawBody?: Buffer }>();

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

    // 2. Timestamp window — rejects replays outside ±300 s even if the dedup
    //    store has already expired the nonce.
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
    const key = this.apiKeys.getKey(keyId);
    if (!key) {
      throw this.unauthorized(ERROR_CODES.API_KEY_UNKNOWN, 'Unknown API key');
    }

    // 4. Signature — recompute over the raw bytes and compare constant-time.
    //    Verified BEFORE the nonce is consumed, so a bad-signature request can't
    //    burn a legitimate nonce (which would fail the real caller's retry).
    const valid = await this.signing.verify(
      {
        method: request.method,
        path: request.originalUrl ?? request.url,
        timestamp,
        nonce,
        body: request.rawBody ?? Buffer.alloc(0),
        keyId,
      },
      signature,
      key.secret,
    );
    if (!valid) {
      throw this.unauthorized(
        ERROR_CODES.SIGNATURE_INVALID,
        'Signature verification failed',
      );
    }

    // 5. Tenant — the key's, never the unsigned hint's.
    const hint = this.tenantHint(request);
    if (hint !== undefined && hint !== key.tenantId) {
      throw new AppError('TENANT_MISMATCH', {
        detail: 'The API key is bound to a different tenant',
      });
    }

    // 6. Tenant status — a suspended tenant's keys stop working.
    assertTenantActive(await this.findTenant(key.tenantId));

    // 7. Nonce dedup — atomic claim, only after the signature is proven
    //    valid. A second VALID request with the same nonce inside the window
    //    fails (replay protection); invalid requests never reach here.
    const fresh = await this.dedup.claim(
      SIGNATURE_NONCE_KEY.global(keyId, nonce),
      NONCE_TTL_SECONDS,
    );
    if (!fresh) {
      throw this.unauthorized(ERROR_CODES.NONCE_REUSED, 'Nonce already used');
    }

    request.tenantId = key.tenantId;
    request.tenantError = undefined;
    return true;
  }

  private async findTenant(id: TenantId) {
    try {
      return await this.tenants.find(id);
    } catch (err) {
      if (isAppError(err)) throw err;
      throw new AppError('SERVICE_UNAVAILABLE', { cause: err });
    }
  }

  private tenantHint(request: Request): string | undefined {
    const header = this.header(request, TENANT_HEADER);
    if (header) return header;
    const query = (request.query as Record<string, unknown> | undefined)?.[
      TENANT_QUERY_PARAM
    ];
    return typeof query === 'string' && query ? query : undefined;
  }

  private header(request: Request, name: string): string | undefined {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }

  private unauthorized(code: ErrorCode, detail: string): AppError {
    return new AppError(code, { detail });
  }
}
