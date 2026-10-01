import type { Namespace, Server } from 'socket.io';
import type { TenantId } from '../../../../common/keyspace';
import { createLogger } from '../../../../common/observability';
import { capabilityUp, type CapabilityHealth } from '../../../capability';
import type { RealtimeAdapter } from '../../realtime.port';
import {
  REALTIME_NAMESPACE,
  roleRoom,
  tenantRoom,
  userRoom,
} from '../../realtime.rooms';

/**
 * In-process delivery for a single node: a publish reaches only sockets
 * held by this process. A process that attached no server drops publishes
 * (warned once), which is why multi-process deployments select `redis`.
 */
export class LocalRealtimeAdapter implements RealtimeAdapter {
  private readonly logger = createLogger('realtime');
  private namespace?: Namespace;
  private warned = false;

  attach(server: Server): void {
    this.namespace = server.of(REALTIME_NAMESPACE);
  }

  publishToUser(
    tenantId: TenantId,
    userId: string,
    event: string,
    data: unknown,
  ): Promise<void> {
    return this.emit(userRoom(tenantId, userId), event, data);
  }

  publishToRoles(
    tenantId: TenantId,
    roles: readonly string[],
    event: string,
    data: unknown,
  ): Promise<void> {
    const rooms = roles.map((role) => roleRoom(tenantId, role));
    return rooms.length ? this.emit(rooms, event, data) : Promise.resolve();
  }

  publishToTenant(
    tenantId: TenantId,
    event: string,
    data: unknown,
  ): Promise<void> {
    return this.emit(tenantRoom(tenantId), event, data);
  }

  health(): Promise<CapabilityHealth> {
    return Promise.resolve(capabilityUp('local'));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  private emit(
    room: string | string[],
    event: string,
    data: unknown,
  ): Promise<void> {
    if (!this.namespace) {
      if (!this.warned) {
        this.warned = true;
        this.logger.warn(
          'local-no-server',
          'REALTIME_ADAPTER=local in a process without sockets; publishes are dropped',
        );
      }
      return Promise.resolve();
    }
    this.namespace.to(room).emit(event, data);
    return Promise.resolve();
  }
}
