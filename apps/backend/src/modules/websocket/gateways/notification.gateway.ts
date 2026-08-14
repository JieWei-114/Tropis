import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { corsOriginFromEnv } from '../../../config/cors.constants';
import { AuthService } from '../../auth/services/auth.service';

@Injectable()
@WebSocketGateway({
  cors: {
    origin: corsOriginFromEnv(),
    credentials: true,
  },
  namespace: '/ws',
})
export class NotificationGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server: Server;

  private readonly logger = new Logger(NotificationGateway.name);
  // userId → Set of socket IDs (one user can have multiple tabs open)
  private readonly userSockets = new Map<string, Set<string>>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly authService: AuthService,
  ) {}

  async handleConnection(client: Socket) {
    const token =
      (client.handshake.auth?.token as string | undefined) ??
      client.handshake.headers?.authorization?.replace('Bearer ', '');

    if (!token) {
      client.disconnect();
      return;
    }

    try {
      const payload = this.jwtService.verify<{
        sub: string;
        email: string;
        jti?: string;
      }>(token);

      // Reject tokens that were revoked via logout (same Redis blacklist as JwtStrategy)
      if (payload.jti && (await this.authService.isBlacklisted(payload.jti))) {
        client.disconnect();
        return;
      }

      client.data.userId = payload.sub;
      client.data.email = payload.email;

      // Join a room named after the userId so we can target a user from anywhere
      await client.join(`user:${payload.sub}`);

      if (!this.userSockets.has(payload.sub)) {
        this.userSockets.set(payload.sub, new Set());
      }
      this.userSockets.get(payload.sub)!.add(client.id);

      this.logger.log(`Connected: ${payload.email} (socket ${client.id})`);
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    const userId = client.data.userId as string | undefined;
    if (userId) {
      this.userSockets.get(userId)?.delete(client.id);
      if (this.userSockets.get(userId)?.size === 0) {
        this.userSockets.delete(userId);
      }
      this.logger.log(`Disconnected: ${userId} (socket ${client.id})`);
    }
  }

  // Send a notification to a specific user (all their open tabs)
  sendToUser(userId: string, event: string, data: unknown) {
    this.server.to(`user:${userId}`).emit(event, data);
  }

  // Broadcast to all connected clients
  broadcast(event: string, data: unknown) {
    this.server.emit(event, data);
  }

  // Client can ping to check connection health
  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket) {
    client.emit('pong', { ts: Date.now() });
  }

  getOnlineUserCount(): number {
    return this.userSockets.size;
  }
}
