import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AnalyticsService } from '../services/analytics.service';

/**
 * Scheduled analytics tasks.
 *
 * How @nestjs/schedule works:
 *   - @Cron() registers a task with node-cron under the hood
 *   - The task runs in the same Node.js process (not a worker thread)
 *   - CronExpression provides readable presets: EVERY_MINUTE, EVERY_HOUR, etc.
 *   - You can also use raw cron strings: '0 0 * * *' = midnight daily
 *
 * Cron vs Pulsar consumer:
 *   Pulsar consumer  → "do X when event Y happens"  (event-driven, real-time)
 *   Cron             → "do X every N minutes/hours"  (time-driven, scheduled)
 *
 * Both coexist in real systems:
 *   - Pulsar: process each analytics event immediately as it arrives
 *   - Cron:   every hour, bust the stats cache so ClickHouse data is refreshed
 *             even if no new events came in
 */
@Injectable()
export class AnalyticsScheduler {
  private readonly logger = new Logger(AnalyticsScheduler.name);

  constructor(private readonly analyticsService: AnalyticsService) {}

  /**
   * Bust the Redis stats cache every hour.
   *
   * Why? ClickHouse data continues to be ingested by the Flink job.
   * Even if no new events arrive via the API, Flink may have written
   * historical data. Busting the cache ensures /analytics/stats
   * always reflects the last hour of activity.
   *
   * Without this cron:
   *   - Stats cache only busts when a new event fires through the API
   *   - If the API is quiet for 30+ seconds, cache expires naturally (30s TTL)
   *   - But if Flink writes backfilled data, it's never reflected until
   *     someone calls the API again
   *
   * Test it: watch the logs for "Scheduled stats cache bust"
   */
  @Cron(CronExpression.EVERY_HOUR)
  async bustStatsCache() {
    this.logger.log(
      'Scheduled stats cache bust — forcing ClickHouse refresh on next request',
    );
    const stats = await this.analyticsService.getStats();
    this.logger.log(
      `Stats refreshed: ${stats.totalEvents} total events, fromCache=${stats.fromCache}`,
    );
  }

  /**
   * Log a heartbeat every 5 minutes so you can see the scheduler is alive.
   * Remove this in production — it's purely for learning.
   *
   * Watch it: pnpm backend → wait → see "Scheduler heartbeat" in logs every 5min
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  heartbeat() {
    this.logger.debug('Scheduler heartbeat — cron is running');
  }
}
