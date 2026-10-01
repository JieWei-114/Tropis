import { Injectable, Inject } from '@nestjs/common';
import { AppError } from '../../../common/errors/app-error';
import type { TenantId } from '../../../common/keyspace';
import { createLogger } from '../../../common/observability/logger';
import { OLAP, type OlapPort } from '../../../infrastructure/olap/olap.port';
import {
  ANALYTICS_EVENTS_TABLE,
  ANALYTICS_MINUTELY_TABLE,
} from '../constants/analytics.constants';
import {
  IEventTypeStat,
  IMinutelyStat,
} from '../interfaces/analytics.interface';

@Injectable()
export class AnalyticsRepository {
  private readonly logger = createLogger('analytics');

  constructor(@Inject(OLAP) private readonly olap: OlapPort) {}

  async insertEvent(
    tenantId: TenantId,
    event: {
      event_id: string;
      event_type: string;
      user_id: string;
      payload: string;
      ts: number;
    },
  ): Promise<void> {
    try {
      await this.olap.insert(tenantId, ANALYTICS_EVENTS_TABLE, [event]);
    } catch (err) {
      throw new AppError('SERVICE_UNAVAILABLE', {
        detail: 'Analytics event insert failed',
        cause: err,
      });
    }
  }

  /**
   * Per-type counts for one tenant.
   *
   * The tenant filter is not optional: results are cached per tenant
   * (ANALYTICS_STATS_CACHE), so an unfiltered query put the whole cluster's counts
   * into every tenant's cache entry — a cross-tenant data leak, not just a
   * wrong number. The OLAP port binds tenant_id and rejects a query without
   * it. tenant_id is the leading key column, so this reads only that
   * tenant's granules.
   */
  async getStatsByType(
    fromMs: number,
    tenantId: TenantId,
  ): Promise<IEventTypeStat[]> {
    try {
      const rows = await this.olap.query<{
        eventType: string;
        count: string;
        lastSeen: string;
      }>(
        tenantId,
        `
          SELECT
            event_type  AS eventType,
            count()     AS count,
            max(ts)     AS lastSeen
          FROM ${ANALYTICS_EVENTS_TABLE}
          WHERE tenant_id = {tenant_id:String} AND ts >= {from:Int64}
          GROUP BY event_type
          ORDER BY count DESC
        `,
        { from: fromMs },
      );

      return rows.map((r) => ({
        eventType: r.eventType,
        count: Number(r.count),
        lastSeen: Number(r.lastSeen),
      }));
    } catch (err) {
      this.logger.warn(
        'stats-query-failed',
        'Analytics stats query failed; returning empty stats',
        {},
        err,
      );
      return [];
    }
  }

  /** Per-minute counts for one tenant. See getStatsByType on the filter. */
  async getMinutelyStats(
    minutes = 60,
    tenantId: TenantId,
  ): Promise<IMinutelyStat[]> {
    try {
      const rows = await this.olap.query<{
        windowMs: string;
        eventType: string;
        count: string;
      }>(
        tenantId,
        `
          SELECT
            toUnixTimestamp(window_start) * 1000 AS windowMs,
            event_type                           AS eventType,
            sum(event_count)                     AS count
          FROM ${ANALYTICS_MINUTELY_TABLE}
          WHERE tenant_id = {tenant_id:String}
            AND window_start >= now() - INTERVAL {minutes:Int32} MINUTE
          GROUP BY window_start, event_type
          ORDER BY window_start ASC
        `,
        { minutes },
      );
      return rows.map((r) => ({
        windowMs: Number(r.windowMs),
        eventType: r.eventType,
        count: Number(r.count),
      }));
    } catch (err) {
      this.logger.warn(
        'minutely-query-failed',
        'Analytics per-minute query failed; returning an empty result',
        {},
        err,
      );
      return [];
    }
  }
}
