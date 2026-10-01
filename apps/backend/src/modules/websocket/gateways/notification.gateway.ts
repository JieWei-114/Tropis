import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  ConnectedSocket,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import {
  Inject,
  Injectable,
  Optional,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  corsOriginFromEnv,
  corsOriginList,
} from '../../../config/cors.constants';
import { isAppErrorLike } from '../../../common/errors/app-error';
import {
  TOKEN_VERIFIER,
  bearerFromHeader,
  type Principal,
  type TokenVerifier,
} from '../../../common/auth/token-verifier.port';
import { createLogger } from '../../../common/observability';
import {
  REALTIME_TRANSPORT,
  type RealtimeTransport,
} from '../../../infrastructure/realtime/realtime.port';
import {
  REALTIME_NAMESPACE,
  roleRoom,
  tenantRoom,
  userRoom,
} from '../../../infrastructure/realtime/realtime.rooms';

/** How often open sockets are re-verified (revocation, account status). */
const WS_REVALIDATE_INTERVAL_MS = 60_000;

/** Sockets re-verified at once per sweep, so a sweep cannot flood the stores. */
export const WS_REVALIDATE_CONCURRENCY = 20;

/** Longest single timer; later expiries are re-armed on firing. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Verification failures that end a session. Anything else (a store
 * outage answering SERVICE_UNAVAILABLE, say) keeps the socket until a
 * later sweep can decide.
 */
export function endsSession(err: unknown): boolean {
  if (!isAppErrorLike(err)) return false;
  return err.code.startsWith('AUTH_') || err.code === 'TENANT_INACTIVE';
}

/**
 * Allowed browser origins, from the validated config once the gateway is
 * constructed (after Vault secrets are merged); the environment before that.
 */
let allowedOrigins: ReadonlySet<string> | null = null;

function allowOrigin(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
): void {
  const allowed = allowedOrigins ?? new Set(corsOriginFromEnv());
  callback(null, !origin || allowed.has(origin));
}

interface RoomMember {
  join(rooms: string | string[]): unknown;
  leave(room: string): unknown;
  data: { session?: SocketSession };
}

interface SocketSession {
  principal: Principal;
  token: string;
}

/**
 * Socket.IO gateway at /ws. The handshake token goes through the shared
 * TokenVerifier; a socket then joins only its tenant room, its own user room
 * and the rooms of the roles its user holds (kept in step with the member
 * record on every re-verification, so a demotion leaves the role room). The gateway emits nothing itself: producers in any process publish
 * through the realtime port (REALTIME), whose transport this gateway attaches
 * to its server, and every publish targets one of those rooms.
 * A socket is disconnected when its token expires (a timer at `exp`) and
 * when a periodic re-verification ends its session (logout, suspension,
 * deletion, an inactive tenant); a store outage during re-verification keeps
 * it. CORS origins come from the validated CORS_ORIGIN.
 */
@Injectable()
@WebSocketGateway({
  cors: {
    origin: allowOrigin,
    credentials: true,
  },
  namespace: REALTIME_NAMESPACE,
})
export class NotificationGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleDestroy
{
  @WebSocketServer() server: Namespace;

  private readonly logger = createLogger('websocket');
  private revalidation: NodeJS.Timeout | null = null;
  private revalidating = false;
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();
  private readonly userSockets = new Map<string, Set<string>>();

  constructor(
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @Inject(REALTIME_TRANSPORT) private readonly transport: RealtimeTransport,
    @Optional() config?: ConfigService,
  ) {
    const configured = config?.get<string>('CORS_ORIGIN');
    if (configured !== undefined) {
      allowedOrigins = new Set(corsOriginList(configured));
    }
  }

  afterInit(namespace: Namespace): void {
    this.transport.attach(namespace.server);
    this.revalidation = setInterval(
      () => void this.revalidationTick(),
      WS_REVALIDATE_INTERVAL_MS,
    );
    this.revalidation.unref();
  }

  /** One sweep at a time: a tick that finds the last one running is skipped. */
  async revalidationTick(): Promise<void> {
    if (this.revalidating) return;
    this.revalidating = true;
    try {
      await this.revalidateConnections();
    } catch (err) {
      this.logger.warn(
        'revalidation-failed',
        'Socket revalidation sweep failed',
        {},
        err,
      );
    } finally {
      this.revalidating = false;
    }
  }

  onModuleDestroy(): void {
    if (this.revalidation) clearInterval(this.revalidation);
    this.revalidation = null;
  }

  async handleConnection(client: Socket): Promise<void> {
    const token =
      (client.handshake.auth?.token as string | undefined) ??
      bearerFromHeader(client.handshake.headers?.authorization);
    if (!token) {
      client.disconnect(true);
      return;
    }

    let principal: Principal;
    try {
      principal = await this.verifier.verify(token);
    } catch {
      client.disconnect(true);
      return;
    }
    // The client may have gone while the token was verified; its disconnect
    // handler already ran, so nothing recorded now would ever be cleared.
    if (!client.connected) return;

    const session: SocketSession = { principal, token };
    client.data.session = session;
    await client.join([
      tenantRoom(principal.tenantId),
      userRoom(principal.tenantId, principal.userId),
      ...principal.roles.map((role) => roleRoom(principal.tenantId, role)),
    ]);
    if (!client.connected) return;
    this.armExpiry(client, principal.exp);

    const key = userRoom(principal.tenantId, principal.userId);
    if (!this.userSockets.has(key)) this.userSockets.set(key, new Set());
    this.userSockets.get(key)!.add(client.id);
  }

  handleDisconnect(client: Socket): void {
    const timer = this.expiryTimers.get(client.id);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(client.id);

    const session = client.data.session as SocketSession | undefined;
    if (!session) return;
    const key = userRoom(session.principal.tenantId, session.principal.userId);
    this.userSockets.get(key)?.delete(client.id);
    if (this.userSockets.get(key)?.size === 0) this.userSockets.delete(key);
  }

  /**
   * Re-verifies this process's open sockets every WS_REVALIDATE_INTERVAL_MS,
   * WS_REVALIDATE_CONCURRENCY at a time, closing those whose session ended
   * (endsSession); a socket whose check failed for another reason stays.
   */
  async revalidateConnections(): Promise<void> {
    const sockets = await this.server?.local?.fetchSockets?.();
    if (!sockets?.length) return;
    let unverified = 0;
    let next = 0;
    const worker = async () => {
      while (next < sockets.length) {
        const socket = sockets[next++];
        const session = socket.data.session as SocketSession | undefined;
        if (!session) {
          socket.disconnect(true);
          continue;
        }
        let current: Principal;
        try {
          current = await this.verifier.verify(session.token);
        } catch (err) {
          if (endsSession(err)) socket.disconnect(true);
          else unverified += 1;
          continue;
        }
        await this.syncRoleRooms(socket, session, current);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(WS_REVALIDATE_CONCURRENCY, sockets.length) },
        worker,
      ),
    );
    if (unverified) {
      this.logger.warn(
        'revalidation-deferred',
        'Sockets could not be re-verified; they stay open until a later sweep',
        { 'websocket.sockets_unverified': unverified },
      );
    }
  }

  private async syncRoleRooms(
    socket: RoomMember,
    session: SocketSession,
    current: Principal,
  ): Promise<void> {
    const tenantId = current.tenantId;
    const before = new Set(session.principal.roles);
    const after = new Set(current.roles);
    for (const role of before) {
      if (!after.has(role)) await socket.leave(roleRoom(tenantId, role));
    }
    const added = current.roles.filter((role) => !before.has(role));
    if (added.length) {
      await socket.join(added.map((role) => roleRoom(tenantId, role)));
    }
    socket.data.session = { ...session, principal: current };
  }

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket) {
    client.emit('pong', { ts: Date.now() });
  }

  getOnlineUserCount(): number {
    return this.userSockets.size;
  }

  private armExpiry(client: Socket, exp: number): void {
    const delay = exp * 1000 - Date.now();
    if (delay <= 0) {
      client.disconnect(true);
      return;
    }
    const timer = setTimeout(
      () => {
        this.expiryTimers.delete(client.id);
        if (Date.now() >= exp * 1000) {
          this.logger.debug('socket-token-expired', 'Socket token expired', {
            'websocket.socket_id': client.id,
          });
          client.disconnect(true);
        } else {
          this.armExpiry(client, exp);
        }
      },
      Math.min(delay, MAX_TIMER_MS),
    );
    timer.unref?.();
    this.expiryTimers.set(client.id, timer);
  }
}
