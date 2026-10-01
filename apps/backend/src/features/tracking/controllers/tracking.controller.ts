import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../common/decorators/public.decorator';
import { RequireSignature } from '../../../common/decorators/require-signature.decorator';
import { TrackingService } from '../services/tracking.service';
import { TrackBatchDto } from '../dto/track-event.dto';
import { TenantContext } from '../../../common/tenant/tenant.context';

/**
 * REST ingest for the SDK tracker.
 *
 * This is a legitimate REST exception to the gRPC-first rule
 * (docs/architecture.md): the tracker flushes on page unload via
 * navigator.sendBeacon, which can only POST plain HTTP — gRPC-Web is not an
 * option. Reads (GetInsights) stay on gRPC.
 */
@ApiTags('tracking')
@Controller('v1/track')
export class TrackingController {
  constructor(
    private readonly trackingService: TrackingService,
    private readonly tenantCtx: TenantContext,
  ) {}

  /**
   * Anonymous: the tenant comes from X-Tenant-ID, or `?tenant=` for
   * navigator.sendBeacon, which cannot set headers. Without one the batch is
   * rejected with TENANT_REQUIRED, and a tenant that is not registered and
   * active with TENANT_NOT_FOUND / TENANT_INACTIVE, before anything is
   * published.
   */
  @Public()
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  // Generous limit: trackers batch client-side, but many tabs/users share an IP.
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Ingest a batch of user-behavior events (max 100). Responds 202 immediately; delivery is best-effort.',
  })
  async track(@Body() dto: TrackBatchDto): Promise<{ accepted: number }> {
    const tenant = this.tenantCtx.tenant;
    await this.trackingService.assertAccepting(tenant);
    void this.trackingService.ingest(tenant, dto);
    return { accepted: dto.events.length };
  }

  /**
   * Server-to-server ingest: same handler as POST /v1/track, but requires an
   * HMAC-signed request (X-Api-Key / X-Timestamp / X-Nonce / X-Signature —
   * spec in docs/api-conventions.md). Demonstrates the API Key + signature
   * tier: backend jobs and partner servers use this instead of the anonymous
   * browser beacon endpoint. The tenant is the one the API key is bound to
   * (SignatureGuard binds it), never an unsigned header.
   */
  @Public() // skips JWT — identity comes from the API key, not a user token
  @RequireSignature()
  @Post('secure')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Signed server-to-server event ingest (HMAC request signing — docs/api-conventions.md).',
  })
  async trackSecure(@Body() dto: TrackBatchDto): Promise<{ accepted: number }> {
    const tenant = this.tenantCtx.tenant;
    await this.trackingService.assertAccepting(tenant);
    void this.trackingService.ingest(tenant, dto);
    return { accepted: dto.events.length };
  }
}
