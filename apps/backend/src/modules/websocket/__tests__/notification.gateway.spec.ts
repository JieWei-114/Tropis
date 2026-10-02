import { toTenantId } from '../../../common/keyspace';
import type { ConfigService } from '@nestjs/config';
import { AppError } from '../../../common/errors';
import {
  NotificationGateway,
  WS_REVALIDATE_CONCURRENCY,
} from '../gateways/notification.gateway';
import {
  roleRoom,
  tenantRoom,
  userRoom,
} from '../../../infrastructure/realtime/realtime.rooms';
import {
  TEST_TENANT,
  signAccessToken,
  testTokenVerifier,
  type TestVerifier,
} from '../../auth/__tests__/token-fixtures';
import { TOKEN_REVOKED_KEY } from '../../auth/constants/auth.constants';
import { UserRole, UserStatus } from '../../user/constants/user.enums';

const ACME = toTenantId(TEST_TENANT);

const mockSocket = (token?: string) => ({
  id: `socket-${Math.random()}`,
  handshake: { auth: { token }, headers: {} },
  data: {} as Record<string, unknown>,
  connected: true,
  join: jest.fn().mockResolvedValue(undefined),
  leave: jest.fn().mockResolvedValue(undefined),
  emit: jest.fn(),
  disconnect: jest.fn(),
});

describe('NotificationGateway', () => {
  let gateway: NotificationGateway;
  let t: TestVerifier;
  let server: {
    emit: jest.Mock;
    server: object;
    local: { fetchSockets: jest.Mock };
  };
  const transport = { attach: jest.fn() };

  beforeEach(() => {
    jest.useRealTimers();
    transport.attach.mockClear();
    t = testTokenVerifier();
    gateway = new NotificationGateway(t.verifier, transport);
    server = {
      emit: jest.fn(),
      server: {},
      local: { fetchSockets: jest.fn().mockResolvedValue([]) },
    };
    (gateway as unknown as { server: unknown }).server = server;
  });

  it('attaches the realtime transport to its Socket.IO server', () => {
    gateway.afterInit(server as never);
    expect(transport.attach).toHaveBeenCalledWith(server.server);
  });

  describe('handleConnection', () => {
    it('disconnects a socket with no token', async () => {
      const socket = mockSocket(undefined);
      await gateway.handleConnection(socket as never);
      expect(socket.disconnect).toHaveBeenCalled();
    });

    it('disconnects a socket with an invalid token', async () => {
      const socket = mockSocket('bad.token');
      await gateway.handleConnection(socket as never);
      expect(socket.disconnect).toHaveBeenCalled();
      expect(socket.join).not.toHaveBeenCalled();
    });

    it('disconnects a socket whose token is revoked', async () => {
      await t.kv.set(TOKEN_REVOKED_KEY.global('j1'), true, { ttlSeconds: 60 });
      const socket = mockSocket(signAccessToken({ jti: 'j1' }));
      await gateway.handleConnection(socket as never);
      expect(socket.disconnect).toHaveBeenCalled();
      expect(gateway.getOnlineUserCount()).toBe(0);
    });

    it('disconnects the socket of a suspended account', async () => {
      t = testTokenVerifier(UserStatus.INACTIVE);
      gateway = new NotificationGateway(t.verifier, transport);
      const socket = mockSocket(signAccessToken());
      await gateway.handleConnection(socket as never);
      expect(socket.disconnect).toHaveBeenCalled();
    });

    it('joins only its tenant room, its own user room and its role rooms', async () => {
      const socket = mockSocket(signAccessToken({ sub: 'user-123' }));
      await gateway.handleConnection(socket as never);
      expect(socket.join).toHaveBeenCalledWith([
        tenantRoom(ACME),
        userRoom(ACME, 'user-123'),
        roleRoom(ACME, 'admin'),
      ]);
      expect(socket.disconnect).not.toHaveBeenCalled();
      expect(gateway.getOnlineUserCount()).toBe(1);
    });
  });

  // Reproduces the gap: a client that left while its token was verified was
  // still counted online and got an expiry timer nobody would clear.
  it('does no bookkeeping for a client that disconnected during verification', async () => {
    const socket = mockSocket(signAccessToken());
    jest.spyOn(t.verifier, 'verify').mockImplementation(async (token) => {
      socket.connected = false;
      return testTokenVerifier().verifier.verify(token);
    });
    await gateway.handleConnection(socket as never);
    expect(socket.join).not.toHaveBeenCalled();
    expect(gateway.getOnlineUserCount()).toBe(0);
    expect(
      (gateway as unknown as { expiryTimers: Map<string, unknown> })
        .expiryTimers.size,
    ).toBe(0);
  });

  it('moves a socket out of a role room once the member loses the role', async () => {
    const socket = mockSocket(signAccessToken({ sub: 'user-1' }));
    await gateway.handleConnection(socket as never);
    server.local.fetchSockets.mockResolvedValue([socket]);

    t.members.findMember.mockResolvedValue({
      status: UserStatus.ACTIVE,
      roles: [UserRole.MEMBER],
    });
    await gateway.revalidateConnections();

    expect(socket.leave).toHaveBeenCalledWith(roleRoom(ACME, 'admin'));
    expect(socket.join).toHaveBeenLastCalledWith([roleRoom(ACME, 'member')]);
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  // Reproduces the gap: the token was checked only at connect and by a
  // 60 s sweep, so a socket stayed open past its token's expiry.
  it('disconnects the socket when its token expires', async () => {
    jest.useFakeTimers({ now: Date.now() });
    const socket = mockSocket(signAccessToken({}, { expiresIn: 5 }));
    await gateway.handleConnection(socket as never);
    expect(socket.disconnect).not.toHaveBeenCalled();

    jest.advanceTimersByTime(5_000);
    expect(socket.disconnect).toHaveBeenCalled();
  });

  it('closes open sockets whose token no longer verifies', async () => {
    const socket = mockSocket(signAccessToken({ jti: 'j2' }));
    await gateway.handleConnection(socket as never);
    server.local.fetchSockets.mockResolvedValue([socket]);

    await gateway.revalidateConnections();
    expect(socket.disconnect).not.toHaveBeenCalled();

    await t.kv.set(TOKEN_REVOKED_KEY.global('j2'), true, { ttlSeconds: 60 });
    await gateway.revalidateConnections();
    expect(socket.disconnect).toHaveBeenCalled();
  });

  it('removes the user from tracking on disconnect', async () => {
    const socket = mockSocket(signAccessToken());
    await gateway.handleConnection(socket as never);
    gateway.handleDisconnect(socket as never);
    expect(gateway.getOnlineUserCount()).toBe(0);
  });

  it('exposes no emit method, so producers must use the realtime port', () => {
    const api = gateway as unknown as Record<string, unknown>;
    for (const name of ['broadcast', 'sendToUser', 'sendToTenant']) {
      expect(api[name]).toBeUndefined();
    }
  });

  it('keeps the same user id apart across tenants', () => {
    expect(userRoom(ACME, 'u1')).not.toBe(userRoom(toTenantId('globex'), 'u1'));
  });

  it('responds to ping with pong', () => {
    const socket = mockSocket();
    gateway.handlePing(socket as never);
    expect(socket.emit).toHaveBeenCalledWith(
      'pong',
      expect.objectContaining({ ts: expect.any(Number) as unknown }),
    );
  });

  describe('revalidation', () => {
    const connected = async (n: number) => {
      const sockets: ReturnType<typeof mockSocket>[] = [];
      for (let i = 0; i < n; i += 1) {
        const socket = mockSocket(signAccessToken({ sub: `user-${i}` }));
        await gateway.handleConnection(socket as never);
        sockets.push(socket);
      }
      server.local.fetchSockets.mockResolvedValue(sockets);
      return sockets;
    };

    it('keeps sockets open when the verifier cannot reach its stores', async () => {
      const [socket] = await connected(1);
      jest
        .spyOn(t.verifier, 'verify')
        .mockRejectedValue(new AppError('SERVICE_UNAVAILABLE'));
      await gateway.revalidateConnections();
      expect(socket.disconnect).not.toHaveBeenCalled();
    });

    it('closes sockets whose session ended or whose tenant went inactive', async () => {
      const [revoked, inactive] = await connected(2);
      jest
        .spyOn(t.verifier, 'verify')
        .mockRejectedValueOnce(new AppError('AUTH_TOKEN_REVOKED'))
        .mockRejectedValueOnce(new AppError('TENANT_INACTIVE'));
      await gateway.revalidateConnections();
      expect(revoked.disconnect).toHaveBeenCalled();
      expect(inactive.disconnect).toHaveBeenCalled();
    });

    it('verifies a bounded number of sockets at once', async () => {
      await connected(WS_REVALIDATE_CONCURRENCY * 3);
      let active = 0;
      let peak = 0;
      const real = t.verifier.verify.bind(
        t.verifier,
      ) as TestVerifier['verifier']['verify'];
      const verify = jest
        .spyOn(t.verifier, 'verify')
        .mockImplementation(async (token) => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 1));
          active -= 1;
          return real(token);
        });
      await gateway.revalidateConnections();
      expect(peak).toBeLessThanOrEqual(WS_REVALIDATE_CONCURRENCY);
      expect(verify).toHaveBeenCalledTimes(WS_REVALIDATE_CONCURRENCY * 3);
    });

    it('skips a tick while the previous sweep is still running', async () => {
      await connected(1);
      let release: () => void = () => undefined;
      server.local.fetchSockets.mockImplementationOnce(
        () => new Promise((r) => (release = () => r([]))),
      );
      const first = gateway.revalidationTick();
      await gateway.revalidationTick();
      expect(server.local.fetchSockets).toHaveBeenCalledTimes(1);
      release();
      await first;
    });
  });

  it('takes its CORS origins from the validated config', () => {
    const config = {
      get: () => 'https://console.example',
    } as unknown as ConfigService;
    gateway = new NotificationGateway(t.verifier, transport, config);
    const decorated = Reflect.getMetadata(
      'websockets:gateway_options',
      NotificationGateway,
    ) as {
      cors: {
        origin: (
          o: string,
          cb: (e: Error | null, ok?: boolean) => void,
        ) => void;
      };
    };
    const allowed = (origin: string) => {
      let result: boolean | undefined;
      decorated.cors.origin(origin, (_e, ok) => (result = ok));
      return result;
    };
    expect(allowed('https://console.example')).toBe(true);
    expect(allowed('http://localhost:5173')).toBe(false);
    expect(allowed('tauri://localhost')).toBe(true);
  });
});
