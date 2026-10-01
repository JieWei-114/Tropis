import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import type { TenantId } from '../../../common/keyspace';
import { createLogger } from '../../../common/observability/logger';
import { escapeHtml } from '../../../common/utils/escape-html';
import { CapabilityDisabledError } from '../../../infrastructure/capability';
import {
  CACHE,
  type CachePort,
} from '../../../infrastructure/cache/cache.port';
import { NotificationService } from '../../notification/services/notification.service';
import { USER_EVENTS, USER_PROFILE_CACHE } from '../constants/user.constants';
import { UserRepository } from '../repositories/user.repository';
import type { UserDocument } from '../schemas/user.schema';
import { OnboardingService } from './onboarding.service';
import { UserSearchService } from './user-search.service';

interface Sink {
  name: string;
  run: Promise<unknown>;
}

/**
 * The durable side effects of user events: search index, similarity
 * vectors, profile cache, welcome email and onboarding follow-up.
 *
 * Version-safe: a nacked event can be redelivered after later ones of the
 * same user, so the event payload is never projected. The current user is
 * re-read and projected, and a user that is gone (soft-deleted) is purged:
 * an old user.updated arriving after user.deleted cannot bring it back.
 */
@Injectable()
export class UserProjectionService {
  private readonly logger = createLogger('user');

  constructor(
    private readonly users: UserRepository,
    private readonly search: UserSearchService,
    private readonly notifications: NotificationService,
    private readonly onboarding: OnboardingService,
    @Inject(CACHE) private readonly cache: CachePort,
  ) {}

  /** Applies one user event; throws when a sink failed, so it is redelivered. */
  async apply(
    eventType: string,
    tenantId: TenantId,
    userId: string,
  ): Promise<void> {
    switch (eventType) {
      case USER_EVENTS.CREATED:
      case USER_EVENTS.UPDATED: {
        const current = await this.users.findById(tenantId, userId);
        if (!current) await this.onDeleted(tenantId, userId);
        else if (eventType === USER_EVENTS.CREATED) {
          await this.onCreated(tenantId, userId, current);
        } else await this.onUpdated(tenantId, userId, current);
        return;
      }
      case USER_EVENTS.DELETED:
        await this.onDeleted(tenantId, userId);
        return;
      default:
        this.logger.warn('event-type-unknown', 'Unknown user event type', {
          'event.type': eventType,
        });
    }
  }

  /**
   * Runs every sink, then fails if any of them failed, so the broker
   * redelivers instead of acking an event with a sink missing. A sink whose
   * capability is switched off (CapabilityDisabledError) does not count as a
   * failure. A single failure replays every sink, so each is idempotent.
   */
  private async runSinks(label: string, sinks: Sink[]): Promise<void> {
    const results = await Promise.allSettled(sinks.map((t) => t.run));
    const failed = results
      .map((r, i) => ({ r, name: sinks[i].name }))
      .filter(
        (x) =>
          x.r.status === 'rejected' &&
          !(x.r.reason instanceof CapabilityDisabledError),
      )
      .map(
        (x) =>
          `${x.name}: ${((x.r as PromiseRejectedResult).reason as Error)?.message ?? 'unknown'}`,
      );
    if (failed.length) {
      throw new AppError('SERVICE_UNAVAILABLE', {
        detail: `${label}: ${failed.join('; ')}`,
      });
    }
  }

  private async onCreated(tenantId: TenantId, userId: string, u: UserDocument) {
    await this.runSinks('user created', [
      ...this.search.indexSinks(tenantId, userId, u),
      { name: 'welcome-email', run: this.welcome(tenantId, userId, u) },
    ]);
    this.logger.debug(
      'user-created-applied',
      'User created: indexed and welcomed',
      { 'user.id': userId },
    );
    this.onboarding.start(tenantId, {
      userId,
      email: u.email ?? '',
      name: u.name || 'there',
    });
  }

  /**
   * The welcome email job. Its id is deterministic, so a redelivery cannot
   * enqueue a second email. BullMQ rejects ':' in a custom id (its key
   * separator), so the separator stays '-'.
   */
  private welcome(tenantId: TenantId, userId: string, u: UserDocument) {
    return this.notifications.enqueue(
      {
        tenantId,
        userId,
        channel: 'email',
        template: 'welcome',
        payload: {
          to: u.email ?? '',
          name: u.name ?? '',
          subject: 'Welcome!',
          html: `<p>Hi ${escapeHtml(u.name || 'there')}, welcome to the platform.</p>`,
        },
      },
      `welcome-${userId}`,
    );
  }

  private async onUpdated(tenantId: TenantId, userId: string, u: UserDocument) {
    await this.cache.del(USER_PROFILE_CACHE.forTenant(tenantId, userId));
    await this.runSinks(
      'user updated',
      this.search.indexSinks(tenantId, userId, u),
    );
    this.logger.debug(
      'user-updated-applied',
      'User updated: cache cleared and re-indexed',
      { 'user.id': userId },
    );
  }

  private async onDeleted(tenantId: TenantId, userId: string) {
    await this.cache.del(USER_PROFILE_CACHE.forTenant(tenantId, userId));
    await this.runSinks(
      'user deleted',
      this.search.removeSinks(tenantId, userId),
    );
    this.logger.debug('user-deleted-applied', 'User deleted: purged', {
      'user.id': userId,
    });
  }
}
