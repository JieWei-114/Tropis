import { Module } from '@nestjs/common';
import { HealthController } from './controllers/health.controller';
import { HealthModule } from './health.module';

/** GET /api/health on the public HTTP port, for the console's Stack page. */
@Module({
  imports: [HealthModule],
  controllers: [HealthController],
})
export class HealthApiModule {}
