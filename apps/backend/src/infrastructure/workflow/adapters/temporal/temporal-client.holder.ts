import type { Client } from '@temporalio/client';
import { createLogger } from '../../../../common/observability/logger';

/** How long a failed connect blocks the next attempt. */
export const TEMPORAL_RECONNECT_INTERVAL_MS = 10_000;

/**
 * The Temporal client, connected lazily. A failed connect is retried on
 * demand, at most once per interval, and concurrent callers share one
 * attempt, so an engine that was down at boot is picked up once it is back
 * without a restart. `connect` null means the capability is disabled.
 */
export class TemporalClientHolder {
  private readonly logger = createLogger('workflow');
  private client: Client | null = null;
  private attempt: Promise<Client | null> | null = null;
  private nextAttemptAt = 0;

  constructor(
    private readonly connect: (() => Promise<Client>) | null,
    private readonly retryIntervalMs = TEMPORAL_RECONNECT_INTERVAL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** False when the capability is disabled: get() never connects then. */
  get enabled(): boolean {
    return this.connect !== null;
  }

  /** The connected client, without trying to connect. */
  current(): Client | null {
    return this.client;
  }

  /** The client, connecting first when due; null while unreachable. */
  get(): Promise<Client | null> {
    if (this.client) return Promise.resolve(this.client);
    if (!this.connect) return Promise.resolve(null);
    if (this.attempt) return this.attempt;
    if (this.now() < this.nextAttemptAt) return Promise.resolve(null);
    this.nextAttemptAt = this.now() + this.retryIntervalMs;
    const connect = this.connect;
    this.attempt = connect()
      .then((client) => {
        this.client = client;
        this.logger.info('temporal-connected', 'Temporal client connected');
        return client;
      })
      .catch((err: unknown) => {
        this.logger.warn(
          'temporal-unavailable',
          'Temporal is not available; workflow features are unavailable until it is',
          {},
          err,
        );
        return null;
      })
      .finally(() => {
        this.attempt = null;
      });
    return this.attempt;
  }

  async close(): Promise<void> {
    await this.client?.connection.close();
  }
}
