import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize } from '../../../common/authz/authorize.decorator';
import { TenantContext } from '../../../common/tenant/tenant.context';
import { USER_RESOURCE } from '../constants/user.constants';
import {
  OnboardingService,
  type OnboardingSummary,
} from '../services/onboarding.service';

/**
 * Read-only view of the caller's tenant's onboarding workflows, for the
 * console: per-user follow-up status (Users page) and running/completed
 * counts (Stack page). Admin-only (`user:list`, like every other listing of
 * the tenant's users): it names every member's onboarding state.
 */
@ApiTags('workflows')
@ApiBearerAuth()
@Controller('workflows')
export class OnboardingController {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly tenantCtx: TenantContext,
  ) {}

  @Get('onboarding')
  @Authorize(USER_RESOURCE, 'list')
  @ApiOperation({
    summary: 'Onboarding workflow summary + recent executions (admin only)',
  })
  onboardingSummary(): Promise<OnboardingSummary> {
    return this.onboarding.summary(this.tenantCtx.tenant);
  }
}
