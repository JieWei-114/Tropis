import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from '../../../common/decorators/public.decorator';
import { serviceInfo } from '../../../common/observability/service-info';
import { requiredProbes } from '../health.probes';
import {
  HealthProbesService,
  withoutMessages,
  type HealthReport,
} from '../services/health-probes.service';

/**
 * Every capability and shared connection, with the adapter in use, for the
 * console's Stack page. 503 (a HEALTH_CHECK_FAILED problem document) only
 * when one of this role's required dependencies is down; optional ones that
 * are down are listed in `degraded`. Probe results are shared for a few
 * seconds and the route is rate limited, so it cannot be used to amplify
 * load onto the dependencies. Orchestrator probes use /livez and /readyz on
 * the ops port instead (ops-server.ts).
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly probes: HealthProbesService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Check status of every capability and connection' })
  async check(): Promise<HealthReport> {
    const report = await this.probes.report(requiredProbes(serviceInfo().role));
    if (report.status !== 'ok') {
      throw new ServiceUnavailableException(withoutMessages(report));
    }
    return withoutMessages(report);
  }
}
