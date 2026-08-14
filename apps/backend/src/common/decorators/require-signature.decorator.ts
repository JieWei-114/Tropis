import { applyDecorators, UseGuards, SetMetadata } from '@nestjs/common';
import { SignatureGuard } from '../guards/signature.guard';

export const REQUIRE_SIGNATURE_KEY = 'requireSignature';

/**
 * Marks a route as requiring HMAC request signing (server-to-server tier).
 *
 * The caller must send the four signing headers described in
 * docs/api-conventions.md (X-Api-Key, X-Timestamp, X-Nonce, X-Signature).
 * Validation is performed by SignatureGuard: ±300 s timestamp window,
 * Redis nonce dedup, constant-time signature compare.
 *
 * The consuming module must provide SignatureGuard + ApiKeyService.
 */
export function RequireSignature() {
  return applyDecorators(
    SetMetadata(REQUIRE_SIGNATURE_KEY, true),
    UseGuards(SignatureGuard),
  );
}
