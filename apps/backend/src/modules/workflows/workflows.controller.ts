import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { TemporalService } from '../../infrastructure/temporal/temporal.service';

/**
 * Read-only view of the onboarding Temporal workflows, surfaced natively in the
 * console: per-user follow-up status (Users page) and running/completed counts
 * (Stack page). Degrades to empty/zero when Temporal is unavailable.
 *
 * Requires a valid JWT (global JwtAuthGuard) — it exposes per-user onboarding
 * state, so it must not be world-readable.
 */
@ApiTags('workflows')
@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly temporal: TemporalService) {}

  @Get('onboarding')
  @ApiOperation({ summary: 'Onboarding workflow summary + recent executions' })
  async onboarding() {
    if (!this.temporal.available) {
      return {
        available: false,
        summary: { running: 0, completed: 0 },
        items: [],
      };
    }
    const [summary, items] = await Promise.all([
      this.temporal.countOnboarding(),
      this.temporal.listOnboarding(200),
    ]);
    return { available: true, summary, items };
  }
}
