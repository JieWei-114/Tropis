import { Injectable, Inject, Logger } from '@nestjs/common';
import type { ClickHouseClient } from '@clickhouse/client';
import { CLICKHOUSE_CLIENT } from '../../../infrastructure/clickhouse/clickhouse.module';
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
} from '../interfaces/tracking.interface';

/**
 * The only layer touching the ClickHouse driver for the tracking module.
 * All queries are best-effort: ClickHouse may not run locally, so failures
 * are logged and degraded to empty results (tracking is lossy-tolerant).
 */
@Injectable()
export class TrackingRepository {
  private readonly logger = new Logger(TrackingRepository.name);

  constructor(
    @Inject(CLICKHOUSE_CLIENT) private readonly ch: ClickHouseClient,
  ) {}

  async insertEvents(rows: ITrackingRow[]): Promise<void> {
    if (rows.length === 0) return;
    try {
      await this.ch.insert({
        table: TRACKING_TABLE,
        // DateTime64(3) accepts epoch ms as a number in JSONEachRow
        values: rows,
        format: 'JSONEachRow',
      });
    } catch (err) {
      this.logger.warn({ err }, 'ClickHouse tracking insert failed');
    }
  }

  async getTopPages(days: number): Promise<IPageCount[]> {
    return this.query<IPageCount>(
      `SELECT page, count() AS count
       FROM ${TRACKING_TABLE}
       -- 'page.view' = TRACKING_EVENTS.PAGE_VIEW in @tropis/shared (docs/tracking-plan.md)
       WHERE event_name = 'page.view'
         AND timestamp >= now() - INTERVAL {days:Int32} DAY
       GROUP BY page
       ORDER BY count DESC
       LIMIT ${TRACKING_TOP_PAGES_LIMIT}`,
      { days },
      (r: { page: string; count: string }) => ({
        page: r.page,
        count: Number(r.count),
      }),
    );
  }

  async getEventsByName(days: number): Promise<IEventCount[]> {
    return this.query<IEventCount>(
      `SELECT event_name AS eventName, count() AS count
       FROM ${TRACKING_TABLE}
       WHERE timestamp >= now() - INTERVAL {days:Int32} DAY
       GROUP BY event_name
       ORDER BY count DESC`,
      { days },
      (r: { eventName: string; count: string }) => ({
        eventName: r.eventName,
        count: Number(r.count),
      }),
    );
  }

  async getDailyUniques(days: number): Promise<IDailyUnique[]> {
    return this.query<IDailyUnique>(
      `SELECT toDate(timestamp) AS day, uniq(anonymous_id) AS uniques
       FROM ${TRACKING_TABLE}
       WHERE timestamp >= now() - INTERVAL {days:Int32} DAY
       GROUP BY day
       ORDER BY day ASC`,
      { days },
      (r: { day: string; uniques: string }) => ({
        day: r.day,
        uniques: Number(r.uniques),
      }),
    );
  }

  async getRecent(): Promise<IRecentTrackingEvent[]> {
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
       ORDER BY timestamp DESC
       LIMIT ${TRACKING_RECENT_LIMIT}`,
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

  private async query<T>(
    query: string,
    params: Record<string, unknown>,
    map: (row: never) => T,
  ): Promise<T[]> {
    try {
      const result = await this.ch.query({
        query,
        query_params: params,
        format: 'JSONEachRow',
      });
      const rows = await result.json<never>();
      return rows.map(map);
    } catch (err) {
      this.logger.warn(
        { err },
        'ClickHouse tracking query failed — returning empty',
      );
      return [];
    }
  }
}
