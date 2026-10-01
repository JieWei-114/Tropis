import type { TenantId } from '../../common/keyspace';
import type { HealthCheckable } from '../capability';

/**
 * Realtime — server-to-client push to sockets held by any process. Targets
 * are a tenant room, the rooms of some roles inside a tenant, or one user's
 * room inside a tenant; there is no broadcast to every socket, so no push
 * crosses tenants. A push carrying data not every member may see (another
 * user's details) targets a role room, never the tenant room. Delivery is
 * best-effort: a socket that is not connected when the push is published
 * never receives it.
 */
export const REALTIME = Symbol('REALTIME');

/**
 * Gateway-side hook of the same adapter: the process that holds sockets
 * attaches its Socket.IO server so publishes from any process reach them.
 */
export const REALTIME_TRANSPORT = Symbol('REALTIME_TRANSPORT');

export interface RealtimePort extends HealthCheckable {
  /** Every open socket of one user of one tenant. */
  publishToUser(
    tenantId: TenantId,
    userId: string,
    event: string,
    data: unknown,
  ): Promise<void>;
  /**
   * Every open socket of the tenant's users holding any of `roles`, each
   * socket once.
   */
  publishToRoles(
    tenantId: TenantId,
    roles: readonly string[],
    event: string,
    data: unknown,
  ): Promise<void>;
  /** Every open socket of one tenant. */
  publishToTenant(
    tenantId: TenantId,
    event: string,
    data: unknown,
  ): Promise<void>;
}

export interface RealtimeTransport {
  /** The socket server the gateway holds; its type is the adapter's concern. */
  attach(server: object): void;
}

export interface RealtimeAdapter extends RealtimePort, RealtimeTransport {
  close(): Promise<void>;
}

export const REALTIME_ADAPTERS = ['redis', 'local'] as const;
export type RealtimeAdapterName = (typeof REALTIME_ADAPTERS)[number];
