import { Controller, Get, Res } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { PrometheusController } from '@willsoto/nestjs-prometheus';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';

// Prometheus scrapes this endpoint every 15s — exempt it from rate limiting.
@SkipThrottle()
@Controller()
export class MetricsController extends PrometheusController {
  // Scraped by Prometheus, which sends no bearer token.
  @Public()
  @Get()
  async index(@Res({ passthrough: true }) response: Response): Promise<string> {
    return super.index(response);
  }
}
