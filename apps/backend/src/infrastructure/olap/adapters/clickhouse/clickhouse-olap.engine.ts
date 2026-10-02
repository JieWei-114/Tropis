import type { OnApplicationShutdown } from '@nestjs/common';
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { probeCapability, type CapabilityHealth } from '../../../capability';
import type { OlapEngine, OlapParams, OlapRow } from '../../olap.port';

export interface ClickHouseOptions {
  url: string;
  username: string;
  password: string;
  database: string;
}

/**
 * Inserts go through the server's async-insert buffer, which merges the
 * small per-event inserts of the consumers into large parts; waiting for
 * the flush keeps a failed write a rejected insert, so it is redelivered.
 */
export const CLICKHOUSE_INSERT_SETTINGS = {
  async_insert: 1,
  wait_for_async_insert: 1,
} as const;

/** OlapEngine over ClickHouse, reading and writing JSONEachRow. */
export class ClickHouseOlapEngine implements OlapEngine, OnApplicationShutdown {
  private readonly ch: ClickHouseClient;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(options: ClickHouseOptions, client?: ClickHouseClient) {
    this.ch = client ?? createClient(options);
  }

  async insert(table: string, rows: readonly object[]): Promise<void> {
    const write = this.ch.insert({
      table,
      values: [...rows],
      format: 'JSONEachRow',
      clickhouse_settings: CLICKHOUSE_INSERT_SETTINGS,
    });
    this.inFlight.add(write);
    try {
      await write;
    } finally {
      this.inFlight.delete(write);
    }
  }

  async query(sql: string, params: OlapParams): Promise<OlapRow[]> {
    const result = await this.ch.query({
      query: sql,
      query_params: params,
      format: 'JSONEachRow',
    });
    return result.json<OlapRow>();
  }

  async sortingKey(table: string): Promise<string[]> {
    const dot = table.indexOf('.');
    const database = dot >= 0 ? table.slice(0, dot) : '';
    const name = dot >= 0 ? table.slice(dot + 1) : table;
    const rows = await this.query(
      `SELECT sorting_key FROM system.tables
       WHERE database = if({database:String} = '', currentDatabase(), {database:String})
         AND name = {name:String}`,
      { database, name },
    );
    if (!rows.length) throw new Error(`OLAP table ${table} does not exist`);
    const sortingKey = rows[0].sorting_key;
    return (typeof sortingKey === 'string' ? sortingKey : '')
      .split(',')
      .map((column) => column.trim())
      .filter(Boolean);
  }

  health(): Promise<CapabilityHealth> {
    return probeCapability('clickhouse', async () => {
      const result = await this.ch.ping();
      if (!result.success) throw result.error;
    });
  }

  /** Waits for inserts in flight (each holds its request until the async-insert flush) before closing. */
  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
    await this.ch.close().catch(() => undefined);
  }
}
