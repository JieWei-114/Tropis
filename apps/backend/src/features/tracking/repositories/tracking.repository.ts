import { Injectable, Inject } from '@nestjs/common';
import type { TenantId } from '../../../common/keyspace';
import { createLogger } from '../../../common/observability/logger';
import {
  OLAP,
  type OlapParams,
  type OlapPort,
} from '../../../infrastructure/olap/olap.port';
import {
  TRACKING_TABLE,
  TRACKING_TOP_PAGES_LIMIT,
  TRACKING_RECENT_LIMIT,
} from '../constants/tracking.constants';
import {
  ITrackingRow,
  IPageCount,
  IEventCount,
  IDailyUnique,
  IRecentTrackingEvent,
  IFunnelStep,
} from '../interfaces/tracking.interface';

/**
 * The only layer touching the OLAP store for the tracking module.
 * All queries are best-effort: the store may not run locally, so failures
 * are logged and degraded to empty results (tracking is lossy-tolerant).
 */
@Injectable()
export class TrackingRepository {
  private readonly logger = createLogger('tracking');

  constructor(@Inject(OLAP) private readonly olap: OlapPort) {}

  async insertEvents(tenantId: TenantId, rows: ITrackingRow[]): Promise<void> {
    if (rows.length === 0) return;
    try {
      // DateTime64(3) accepts epoch ms as a number
      await this.olap.insert(tenantId, TRACKING_TABLE, rows);
    } catch (err) {
      // Loud on purpose: a rejected JSONEachRow batch drops EVERY event in it,
      // and the client already received a 202, so this is silent data loss if
      // it is only logged at warn level.
      this.logger.error('insert-failed', 'Tracking batch insert failed', err, {
        'tracking.events': rows.length,
      });
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async getTopPages(days: number, tenantId: TenantId): Promise<IPageCount[]> {
    return this.query<IPageCount>(
      `SELECT page, count() AS count
       FROM ${TRACKING_TABLE}
       -- 'page.view' = TRACKING_EVENTS.PAGE_VIEW in @tropis/shared (docs/tracking-plan.md)
       WHERE tenant_id = {tenant_id:String}
         AND event_name = 'page.view'
         AND timestamp >= now() - INTERVAL {days:Int32} DAY
       GROUP BY page
       ORDER BY count DESC
       LIMIT ${TRACKING_TOP_PAGES_LIMIT}`,
      tenantId,
      { days },
      (r: { page: string; count: string }) => ({
        page: r.page,
        count: Number(r.count),
      }),
    );
  }

  async getEventsByName(
    days: number,
    tenantId: TenantId,
  ): Promise<IEventCount[]> {
    return this.query<IEventCount>(
      `SELECT event_name AS eventName, count() AS count
       FROM ${TRACKING_TABLE}
       WHERE tenant_id = {tenant_id:String}
         AND timestamp >= now() - INTERVAL {days:Int32} DAY
       GROUP BY event_name
       ORDER BY count DESC`,
      tenantId,
      { days },
      (r: { eventName: string; count: string }) => ({
        eventName: r.eventName,
        count: Number(r.count),
      }),
    );
  }

  async getDailyUniques(
    days: number,
    tenantId: TenantId,
  ): Promise<IDailyUnique[]> {
    return this.query<IDailyUnique>(
      `SELECT toDate(timestamp) AS day, uniq(anonymous_id) AS uniques
       FROM ${TRACKING_TABLE}
       WHERE tenant_id = {tenant_id:String}
         AND timestamp >= now() - INTERVAL {days:Int32} DAY
       GROUP BY day
       ORDER BY day ASC`,
      tenantId,
      { days },
      (r: { day: string; uniques: string }) => ({
        day: r.day,
        uniques: Number(r.uniques),
      }),
    );
  }

  async getRecent(tenantId: TenantId): Promise<IRecentTrackingEvent[]> {
    return this.query<IRecentTrackingEvent>(
      `SELECT
         toString(event_id)            AS eventId,
         event_name                    AS eventName,
         anonymous_id                  AS anonymousId,
         user_id                       AS userId,
         session_id                    AS sessionId,
         page,
         props,
         toUnixTimestamp64Milli(timestamp) AS timestamp
       FROM ${TRACKING_TABLE}
       WHERE tenant_id = {tenant_id:String}
       ORDER BY timestamp DESC
       LIMIT ${TRACKING_RECENT_LIMIT}`,
      tenantId,
      {},
      (r: {
        eventId: string;
        eventName: string;
        anonymousId: string;
        userId: string;
        sessionId: string;
        page: string;
        props: string;
        timestamp: string;
      }) => ({ ...r, timestamp: Number(r.timestamp) }),
    );
  }

  // Conversion funnel via ClickHouse windowFunnel: how many anonymous users
  // reached each step (page.view → nav.click → user.login) within a 30-min
  // window. See infra/clickhouse/queries/funnel.sql.
  async getFunnel(days: number, tenantId: TenantId): Promise<IFunnelStep[]> {
    return this.query<IFunnelStep>(
      `WITH f AS (
         SELECT anonymous_id,
                windowFunnel(1800)(
                  toDateTime(timestamp),
                  event_name = 'page.view',
                  event_name = 'nav.click',
                  event_name = 'user.login'
                ) AS level
         FROM ${TRACKING_TABLE}
         WHERE tenant_id = {tenant_id:String}
           AND timestamp >= now() - INTERVAL {days:Int32} DAY
         GROUP BY anonymous_id
       )
       SELECT ord, step, users FROM (
         SELECT 1 AS ord, 'page.view'  AS step, toString(countIf(level >= 1)) AS users FROM f
         UNION ALL SELECT 2, 'nav.click',  toString(countIf(level >= 2)) FROM f
         UNION ALL SELECT 3, 'user.login', toString(countIf(level >= 3)) FROM f
       )
       ORDER BY ord`,
      tenantId,
      { days },
      (r: { step: string; users: string }) => ({
        step: r.step,
        users: Number(r.users),
      }),
    );
  }

  private async query<T>(
    query: string,
    tenantId: TenantId,
    params: OlapParams,
    map: (row: never) => T,
  ): Promise<T[]> {
    try {
      const rows = await this.olap.query(tenantId, query, params);
      return rows.map((row) => map(row as never));
    } catch (err) {
      this.logger.warn(
        'query-failed',
        'Tracking query failed; returning an empty result',
        {},
        err,
      );
      return [];
    }
  }
}
