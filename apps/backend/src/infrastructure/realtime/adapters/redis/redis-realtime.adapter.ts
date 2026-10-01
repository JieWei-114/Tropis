import { createAdapter } from '@socket.io/redis-adapter';
import { Emitter } from '@socket.io/redis-emitter';
import type Redis from 'ioredis';
import type { Server } from 'socket.io';
import type { TenantId } from '../../../../common/keyspace';
import { probeCapability, type CapabilityHealth } from '../../../capability';
import type { RealtimeAdapter } from '../../realtime.port';
import {
  REALTIME_NAMESPACE,
  roleRoom,
  tenantRoom,
  userRoom,
} from '../../realtime.rooms';

/**
 * Cross-process delivery over Redis pub/sub. Publishers use the Socket.IO
 * emitter, which needs no server, so a worker reaches sockets held by public
 * processes; a gateway attaches the Socket.IO Redis adapter, which relays
 * every publish on the channel to the sockets it holds.
 */
export class RedisRealtimeAdapter implements RealtimeAdapter {
  private readonly emitter: Emitter;
  private readonly subscribers: Redis[] = [];
  /** Publishes issued by the emit in progress (emit is synchronous). */
  private collecting: Promise<unknown>[] | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly channelKey: string,
  ) {
    const publisher = {
      publish: (channel: string, message: Buffer) => {
        const sent = redis.publish(channel, message);
        if (this.collecting) this.collecting.push(sent);
        else void sent.catch(() => undefined);
        return sent;
      },
    };
    this.emitter = new Emitter(publisher, { key: channelKey }).of(
      REALTIME_NAMESPACE,
    );
  }

  attach(server: Server): void {
    const pub = this.redis.duplicate();
    const sub = this.redis.duplicate();
    this.subscribers.push(pub, sub);
    server.adapter(createAdapter(pub, sub, { key: this.channelKey }));
  }

  publishToUser(
    tenantId: TenantId,
    userId: string,
    event: string,
    data: unknown,
  ): Promise<void> {
    return this.send(() =>
      this.emitter.to(userRoom(tenantId, userId)).emit(event, data),
    );
  }

  publishToRoles(
    tenantId: TenantId,
    roles: readonly string[],
    event: string,
    data: unknown,
  ): Promise<void> {
    const rooms = roles.map((role) => roleRoom(tenantId, role));
    if (!rooms.length) return Promise.resolve();
    return this.send(() => this.emitter.to(rooms).emit(event, data));
  }

  publishToTenant(
    tenantId: TenantId,
    event: string,
    data: unknown,
  ): Promise<void> {
    return this.send(() =>
      this.emitter.to(tenantRoom(tenantId)).emit(event, data),
    );
  }

  /**
   * The emitter publishes synchronously and drops the promise; collect the
   * ones this emit issued, so a call settles with its own publishes only.
   */
  private async send(emit: () => unknown): Promise<void> {
    const mine: Promise<unknown>[] = [];
    this.collecting = mine;
    try {
      emit();
    } finally {
      this.collecting = null;
    }
    await Promise.all(mine);
  }

  health(): Promise<CapabilityHealth> {
    return probeCapability('redis', () => this.redis.ping());
  }

  async close(): Promise<void> {
    await Promise.all(
      this.subscribers.splice(0).map((c) => c.quit().catch(() => undefined)),
    );
  }
}
