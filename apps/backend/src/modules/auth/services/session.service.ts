import { Inject, Injectable } from '@nestjs/common';
import type { TenantId } from '../../../common/keyspace';
import { createLogger } from '../../../common/observability/logger';
import { KV, type KvPort } from '../../../infrastructure/kv/kv.port';
import { SESSION_KEY, SESSION_TTL_SECONDS } from '../constants/auth.constants';

export interface SessionRecord {
  userId: string;
  email: string;
  loginAt: number;
  ip: string;
}

/**
 * Active session record per user, in the kv capability (KV_ADAPTER selects
 * redis or aerospike). The record expires with its TTL, so no cleanup job
 * exists.
 *
 * Wiring (all fire-and-forget; every method logs and degrades to a no-op
 * when kv is unavailable):
 *   AuthService.login()   → create()      — records the new session
 *   AuthService.logout()  → invalidate()  — removes the session record
 *   AuthService.refresh() → create()      — re-creates the record on rotation
 */
@Injectable()
export class SessionService {
  private readonly logger = createLogger('auth');

  constructor(@Inject(KV) private readonly kv: KvPort) {}

  async create(
    tenantId: TenantId,
    userId: string,
    email: string,
    ip = '',
  ): Promise<void> {
    try {
      const record: SessionRecord = { userId, email, loginAt: Date.now(), ip };
      await this.kv.set(SESSION_KEY.forTenant(tenantId, userId), record, {
        ttlSeconds: SESSION_TTL_SECONDS,
      });
      this.logger.debug('session-created', 'Session created', {
        'user.id': userId,
      });
    } catch (err) {
      this.logger.warn(
        'session-create-failed',
        'Session create failed',
        { 'user.id': userId },
        err,
      );
    }
  }

  async get(tenantId: TenantId, userId: string): Promise<SessionRecord | null> {
    try {
      return (
        (await this.kv.get<SessionRecord>(
          SESSION_KEY.forTenant(tenantId, userId),
        )) ?? null
      );
    } catch {
      return null;
    }
  }

  async invalidate(tenantId: TenantId, userId: string): Promise<void> {
    try {
      await this.kv.del(SESSION_KEY.forTenant(tenantId, userId));
      this.logger.debug('session-invalidated', 'Session invalidated', {
        'user.id': userId,
      });
    } catch (err) {
      this.logger.warn(
        'session-invalidate-failed',
        'Session invalidate failed',
        { 'user.id': userId },
        err,
      );
    }
  }
}
