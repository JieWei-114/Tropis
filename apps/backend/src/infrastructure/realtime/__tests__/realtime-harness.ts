import { createServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { Server, type DefaultEventsMap } from 'socket.io';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import type {
  Principal,
  TokenVerifier,
} from '../../../common/auth/token-verifier.port';
import { toTenantId, type TenantId } from '../../../common/keyspace';
import {
  NotificationGateway,
  type SocketData,
} from '../../../modules/websocket/gateways/notification.gateway';
import { sleep } from '../../capability/__tests__/conformance-helpers';
import type { RealtimeTransport } from '../realtime.port';
import {
  REALTIME_NAMESPACE,
  roleRoom,
  tenantRoom,
  userRoom,
} from '../realtime.rooms';

/**
 * Token `<tenant>|<user>[|<role,role>]` stands for that principal; anything
 * else is rejected.
 */
const fakeVerifier: TokenVerifier = {
  verify(token: string): Promise<Principal> {
    const [tenant, userId, roles = ''] = token.split('|');
    if (!tenant || !userId) return Promise.reject(new Error('bad token'));
    return Promise.resolve({
      userId,
      email: `${userId}@example.test`,
      roles: roles ? roles.split(',') : [],
      tenantId: toTenantId(tenant),
      jti: `${tenant}-${userId}`,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  },
};

/** One process holding sockets: a Socket.IO server running the real gateway. */
export interface GatewayNode {
  connect(
    tenantId: TenantId,
    userId: string,
    roles?: string[],
  ): Promise<ClientSocket>;
  close(): Promise<void>;
}

export async function startGatewayNode(
  transport: RealtimeTransport,
): Promise<GatewayNode> {
  const http: HttpServer = createServer();
  const server = new Server<
    DefaultEventsMap,
    DefaultEventsMap,
    DefaultEventsMap,
    SocketData
  >(http);
  const namespace = server.of(REALTIME_NAMESPACE);
  const gateway = new NotificationGateway(fakeVerifier, transport);
  gateway.server = namespace;
  gateway.afterInit(namespace);
  namespace.on('connection', (socket) => {
    void gateway.handleConnection(socket);
    socket.on('disconnect', () => gateway.handleDisconnect(socket));
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  const clients: ClientSocket[] = [];

  return {
    async connect(tenantId, userId, roles = []) {
      const client = io(`http://127.0.0.1:${port}${REALTIME_NAMESPACE}`, {
        auth: { token: `${tenantId}|${userId}|${roles.join(',')}` },
        transports: ['websocket'],
        forceNew: true,
      });
      clients.push(client);
      await new Promise<void>((resolve, reject) => {
        client.once('connect', () => resolve());
        client.once('connect_error', reject);
      });
      const rooms = [
        tenantRoom(tenantId),
        userRoom(tenantId, userId),
        ...roles.map((role) => roleRoom(tenantId, role)),
      ];
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const socket = namespace.sockets.get(client.id!);
        if (socket && rooms.every((r) => socket.rooms.has(r))) return client;
        await sleep(20);
      }
      throw new Error('socket never joined its rooms');
    },
    async close() {
      clients.forEach((c) => c.disconnect());
      await server.close();
    },
  };
}

/** Collects every event a client receives. */
export function recorder(
  client: ClientSocket,
): { event: string; data: unknown }[] {
  const seen: { event: string; data: unknown }[] = [];
  client.onAny((event: string, data: unknown) => seen.push({ event, data }));
  return seen;
}
