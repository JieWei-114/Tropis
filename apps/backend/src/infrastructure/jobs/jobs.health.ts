import { Inject, Injectable } from '@nestjs/common';
import { CapabilityHealthIndicator } from '../capability';
import { JOBS, type JobsPort } from './jobs.port';

@Injectable()
export class JobsHealthIndicator extends CapabilityHealthIndicator {
  constructor(@Inject(JOBS) jobs: JobsPort) {
    super('jobs', jobs);
  }
}
