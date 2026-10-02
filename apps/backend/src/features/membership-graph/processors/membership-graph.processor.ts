import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  canonicalEventType,
  EVENT_TYPES,
  USER_EVENTS_TOPIC,
  type UserEventData,
} from '@tropis/shared';
import { createLogger } from '../../../common/observability/logger';
import {
  EventConsumer,
  type ConsumedEvent,
  type ConsumerHandle,
} from '../../../infrastructure/messaging/event-consumer';
import {
  MEMBERSHIP_GRAPH_EVENT_SEEN,
  MEMBERSHIP_GRAPH_SUBSCRIPTION,
} from '../constants/membership-graph.constants';
import { MembershipGraphService } from '../services/membership-graph.service';

const PROJECTED: ReadonlySet<string> = new Set([
  EVENT_TYPES.USER_CREATED,
  EVENT_TYPES.USER_UPDATED,
  EVENT_TYPES.USER_DELETED,
]);

/**
 * Consumes identity.user.created / updated / deleted (the shared user
 * events contract, legacy names included) on its own key_shared subscription and projects them
 * into the membership graph, once per envelope id. When the graph capability
 * is disabled it does not subscribe at all. A nacked event can still come
 * back after a later one, so the projection ignores anything that arrives
 * after the removal.
 */
@Injectable()
export class MembershipGraphProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('membership-graph');
  private subscription: ConsumerHandle | null = null;

  constructor(
    private readonly membership: MembershipGraphService,
    private readonly consumer: EventConsumer,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!(await this.membership.isEnabled())) {
      this.logger.info(
        'projection-disabled',
        'Graph capability disabled; membership projection not started',
      );
      return;
    }
    this.subscription = this.consumer.start<Partial<UserEventData>>({
      topic: USER_EVENTS_TOPIC,
      subscription: MEMBERSHIP_GRAPH_SUBSCRIPTION,
      type: 'key_shared',
      module: 'membership-graph',
      handle: (event) => this.handle(event),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscription?.close();
  }

  /** Exposed for tests; the broker calls it through the subscription. */
  async handle({
    data,
    envelope,
    tenantId,
  }: ConsumedEvent<Partial<UserEventData>>): Promise<void> {
    const userId =
      typeof data.userId === 'string' ? data.userId : envelope.subject;
    if (typeof userId !== 'string' || !userId) return;
    const type = canonicalEventType(envelope.type);
    if (!PROJECTED.has(type)) return;
    const invitedBy =
      'invitedBy' in data && typeof data.invitedBy === 'string'
        ? data.invitedBy || undefined
        : undefined;

    await this.consumer.once(
      MEMBERSHIP_GRAPH_EVENT_SEEN.global(envelope.id),
      async () => {
        if (type === EVENT_TYPES.USER_DELETED) {
          await this.membership.removeMember(tenantId, userId);
          return;
        }
        const applied = await this.membership.recordMember(tenantId, {
          userId,
          invitedBy,
        });
        if (!applied) {
          this.logger.debug(
            'event-after-removal',
            'Event for a removed member ignored',
            { 'cloudevents.event_id': envelope.id },
          );
        }
      },
    );
  }
}
