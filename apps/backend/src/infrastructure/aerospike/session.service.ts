import { Injectable, Inject, Logger } from '@nestjs/common';
import { AEROSPIKE_CLIENT } from './aerospike.constants';

const NAMESPACE = 'test'; // default Aerospike namespace
const SET_NAME = 'sessions';
const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days — Aerospike auto-expires, no cron needed

// Resolve Key constructor once at module load — avoids repeated dynamic require in hot paths

const AerospikeKey = (() => {
  try {
    return require('aerospike').Key as new (
      ns: string,
      set: string,
      id: string,
    ) => unknown;
  } catch {
    return null;
  }
})();

/**
 * Stores active user sessions in Aerospike.
 *
 * Why Aerospike instead of Redis for sessions?
 *   - Aerospike stores the index in RAM and data on SSD → cheaper at scale
 *   - Sub-millisecond reads even at billions of records
 *   - Per-record TTL: records vanish without any cron or manual cleanup
 *   - Redis is used here for application cache (user objects, stats aggregations)
 *     Aerospike is used for auth sessions (userId → session metadata)
 *
 * Record shape:
 *   key      → sessions:<userId>
 *   bins     → { userId, email, loginAt, ip }
 *   TTL      → 7 days
 *
 * Wiring (all fire-and-forget; every method degrades to a no-op when the
 * Aerospike client is null, e.g. package not installed or service down):
 *   AuthService.login()   → create()      — records the new session
 *   AuthService.logout()  → invalidate()  — removes the session record
 *   AuthService.refresh() → create()      — re-creates the record on rotation
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(@Inject(AEROSPIKE_CLIENT) private readonly client: any | null) {}

  async create(userId: string, email: string, ip = ''): Promise<void> {
    if (!this.client || !AerospikeKey) return;

    try {
      const key = new AerospikeKey(NAMESPACE, SET_NAME, userId);
      const bins = { userId, email, loginAt: Date.now(), ip };
      await this.client.put(key, bins, { ttl: SESSION_TTL });
      this.logger.log(`Session created for user ${userId}`);
    } catch (err) {
      this.logger.warn({ err }, 'SessionService.create failed');
    }
  }

  async get(userId: string): Promise<Record<string, unknown> | null> {
    if (!this.client || !AerospikeKey) return null;

    try {
      const key = new AerospikeKey(NAMESPACE, SET_NAME, userId);
      const record = await this.client.get(key);
      return (record?.bins as Record<string, unknown>) ?? null;
    } catch {
      return null; // record not found or TTL expired
    }
  }

  async invalidate(userId: string): Promise<void> {
    if (!this.client || !AerospikeKey) return;

    try {
      const key = new AerospikeKey(NAMESPACE, SET_NAME, userId);
      await this.client.remove(key);
      this.logger.log(`Session invalidated for user ${userId}`);
    } catch {
      // already expired — no-op
    }
  }
}
