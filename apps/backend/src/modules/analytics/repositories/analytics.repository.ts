import { Injectable, Inject, Logger } from '@nestjs/common';
import type { ClickHouseClient } from '@clickhouse/client';
import { CLICKHOUSE_CLIENT } from '../../../infrastructure/clickhouse/clickhouse.module';
import {
  IEventTypeStat,
  IMinutelyStat,
} from '../interfaces/analytics.interface';

@Injectable()
export class AnalyticsRepository {
  private readonly logger = new Logger(AnalyticsRepository.name);

  constructor(
    @Inject(CLICKHOUSE_CLIENT) private readonly ch: ClickHouseClient,
  ) {}

  async insertEvent(event: {
    tenant_id: string;
    event_id: string;
    event_type: string;
    user_id: string;
    payload: string;
    ts: number;
  }): Promise<void> {
    try {
      await this.ch.insert({
        table: 'logs.analytics_events',
        values: [event],
        format: 'JSONEachRow',
      });
    } catch (err) {
      // ClickHouse may not be running locally — log and continue
      this.logger.warn({ err }, 'ClickHouse insert failed');
    }
  }

  /**
   * Per-type counts for one tenant.
   *
   * The tenant filter is not optional: results are cached per tenant
   * (analyticsStatsKey), so an unfiltered query put the whole cluster's counts
   * into every tenant's cache entry — a cross-tenant data leak, not just a
   * wrong number. tenant_id is the leading key column, so this reads only that
   * tenant's granules.
   */
  async getStatsByType(
    fromMs: number,
    tenantId: string,
  ): Promise<IEventTypeStat[]> {
    try {
      const result = await this.ch.query({
        query: `
          SELECT
            event_type  AS eventType,
            count()     AS count,
            max(ts)     AS lastSeen
          FROM logs.analytics_events
          WHERE tenant_id = {tenantId:String} AND ts >= {from:Int64}
          GROUP BY event_type
          ORDER BY count DESC
        `,
        query_params: { from: fromMs, tenantId },
        format: 'JSONEachRow',
      });

      const rows = await result.json<{
        eventType: string;
        count: string;
        lastSeen: string;
      }>();

      return rows.map((r) => ({
        eventType: r.eventType,
        count: Number(r.count),
        lastSeen: Number(r.lastSeen),
      }));
    } catch (err) {
      this.logger.warn(
        { err },
        'ClickHouse query failed — returning empty stats',
      );
      return [];
    }
  }

  /** Per-minute counts for one tenant. See getStatsByType on the filter. */
  async getMinutelyStats(
    minutes = 60,
    tenantId: string,
  ): Promise<IMinutelyStat[]> {
    try {
      const result = await this.ch.query({
        query: `
          SELECT
            toUnixTimestamp(window_start) * 1000 AS windowMs,
            event_type                           AS eventType,
            sum(event_count)                     AS count
          FROM logs.analytics_minutely
          WHERE tenant_id = {tenantId:String}
            AND window_start >= now() - INTERVAL {minutes:Int32} MINUTE
          GROUP BY window_start, event_type
          ORDER BY window_start ASC
        `,
        query_params: { minutes, tenantId },
        format: 'JSONEachRow',
      });
      const rows = await result.json<{
        windowMs: string;
        eventType: string;
        count: string;
      }>();
      return rows.map((r) => ({
        windowMs: Number(r.windowMs),
        eventType: r.eventType,
        count: Number(r.count),
      }));
    } catch (err) {
      this.logger.warn({ err }, 'ClickHouse minutely query failed');
      return [];
    }
  }
}
