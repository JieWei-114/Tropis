import {
  escapeKeyId,
  isTenantId,
  InvalidTenantIdError,
  resolveKeyspaceSettings,
  type KeyspaceSettings,
  type TenantId,
} from '../../common/keyspace';

/** Socket.IO namespace every gateway serves and every publisher targets. */
export const REALTIME_NAMESPACE = '/ws';

function tenantScope(tenantId: TenantId): string {
  if (!isTenantId(tenantId)) throw new InvalidTenantIdError(tenantId);
  return `t.${escapeKeyId(tenantId)}`;
}

/** Room of every socket of one tenant: `t.<tenantId>`. */
export const tenantRoom = (tenantId: TenantId): string => tenantScope(tenantId);

/** Room of one user's sockets: `t.<tenantId>:user:<userId>`. */
export const userRoom = (tenantId: TenantId, userId: string): string =>
  `${tenantScope(tenantId)}:user:${escapeKeyId(userId)}`;

/**
 * Room of the sockets whose user holds `role` in the tenant:
 * `t.<tenantId>:role:<role>`. For pushes only some members may see.
 */
export const roleRoom = (tenantId: TenantId, role: string): string =>
  `${tenantScope(tenantId)}:role:${escapeKeyId(role)}`;

/**
 * Pub/sub channel prefix shared by the gateway adapter and the emitter:
 * `{app}:{env}:global:realtime:socket-io:v1`, so two deployments sharing one
 * Redis never deliver to each other's sockets.
 */
export function realtimeChannelKey(
  settings: KeyspaceSettings = resolveKeyspaceSettings(),
): string {
  return [
    settings.app,
    settings.env,
    'global',
    'realtime',
    'socket-io',
    'v1',
  ].join(':');
}
