import { Test, TestingModule } from '@nestjs/testing';
import { EVENT_TYPES } from '@tropis/shared';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { NotificationGateway } from '../gateways/notification.gateway';
import { AuthService } from '../../auth/services/auth.service';

const mockSocket = (token?: string) => ({
  id: 'socket-abc',
  handshake: { auth: { token }, headers: {} },
  data: {} as Record<string, unknown>,
  join: jest.fn().mockResolvedValue(undefined),
  emit: jest.fn(),
  disconnect: jest.fn(),
});

describe('NotificationGateway', () => {
  let gateway: NotificationGateway;
  let jwtService: jest.Mocked<Pick<JwtService, 'verify'>>;
  let authService: { isBlacklisted: jest.Mock };

  beforeEach(async () => {
    jwtService = {
      verify: jest.fn(),
    };

    authService = {
      isBlacklisted: jest.fn().mockResolvedValue(false),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationGateway,
        { provide: JwtService, useValue: jwtService },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: AuthService, useValue: authService },
      ],
    }).compile();

    gateway = module.get(NotificationGateway);

    // Stub out the Socket.io server
    (gateway as any).server = {
      emit: jest.fn(),
      to: jest.fn().mockReturnThis(),
    };
  });

  describe('handleConnection', () => {
    it('disconnects a socket with no token', async () => {
      const socket = mockSocket(undefined);

      await gateway.handleConnection(socket as any);

      expect(socket.disconnect).toHaveBeenCalled();
    });

    it('disconnects a socket with an invalid token', async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error('invalid');
      });
      const socket = mockSocket('bad.token');

      await gateway.handleConnection(socket as any);

      expect(socket.disconnect).toHaveBeenCalled();
    });

    it('disconnects a socket whose token jti is blacklisted', async () => {
      jwtService.verify.mockReturnValue({
        sub: 'user-123',
        email: 'alice@example.com',
        jti: 'jti-revoked',
      });
      authService.isBlacklisted.mockResolvedValue(true);
      const socket = mockSocket('revoked.token');

      await gateway.handleConnection(socket as any);

      expect(authService.isBlacklisted).toHaveBeenCalledWith('jti-revoked');
      expect(socket.disconnect).toHaveBeenCalled();
      expect(socket.join).not.toHaveBeenCalled();
      expect(gateway.getOnlineUserCount()).toBe(0);
    });

    it('allows connection when jti is not blacklisted', async () => {
      jwtService.verify.mockReturnValue({
        sub: 'user-123',
        email: 'alice@example.com',
        jti: 'jti-ok',
      });
      const socket = mockSocket('valid.token');

      await gateway.handleConnection(socket as any);

      expect(authService.isBlacklisted).toHaveBeenCalledWith('jti-ok');
      expect(socket.disconnect).not.toHaveBeenCalled();
    });

    it('joins user room on valid token', async () => {
      jwtService.verify.mockReturnValue({
        sub: 'user-123',
        email: 'alice@example.com',
      });
      const socket = mockSocket('valid.token');

      await gateway.handleConnection(socket as any);

      expect(socket.join).toHaveBeenCalledWith('user:user-123');
      expect(socket.disconnect).not.toHaveBeenCalled();
    });

    it('tracks connected user count', async () => {
      jwtService.verify.mockReturnValue({
        sub: 'user-123',
        email: 'alice@example.com',
      });
      const socket = mockSocket('valid.token');

      await gateway.handleConnection(socket as any);

      expect(gateway.getOnlineUserCount()).toBe(1);
    });
  });

  describe('handleDisconnect', () => {
    it('removes user from tracking on disconnect', async () => {
      jwtService.verify.mockReturnValue({
        sub: 'user-123',
        email: 'alice@example.com',
      });
      const socket = mockSocket('valid.token');

      await gateway.handleConnection(socket as any);
      gateway.handleDisconnect(socket as any);

      expect(gateway.getOnlineUserCount()).toBe(0);
    });
  });

  describe('sendToUser', () => {
    it('emits event to the correct user room', () => {
      const server = (gateway as any).server;

      gateway.sendToUser('user-123', 'notification', { msg: 'hello' });

      expect(server.to).toHaveBeenCalledWith('user:user-123');
    });
  });

  describe('broadcast', () => {
    it('emits event to all connected clients', () => {
      const server = (gateway as any).server;

      gateway.broadcast(EVENT_TYPES.USER_CREATED, { id: 'user-456' });

      expect(server.emit).toHaveBeenCalledWith(EVENT_TYPES.USER_CREATED, {
        id: 'user-456',
      });
    });
  });

  describe('handlePing', () => {
    it('responds with pong containing a timestamp', () => {
      const socket = mockSocket();
      socket.data = {};

      gateway.handlePing(socket as any);

      expect(socket.emit).toHaveBeenCalledWith(
        'pong',
        expect.objectContaining({ ts: expect.any(Number) }),
      );
    });
  });
});
