/**
 * Auth integration test — real Redis (redis:7-alpine, behind the kv and
 * ratelimit redis adapters) + real MongoDB (mongo:7, single-node replica set
 * via @testcontainers/mongodb).
 *
 * Exercises the real AuthService + UserRepository end to end:
 *   register/create user → login → verify token pair → refresh (rotation) →
 *   old refresh token rejected → logout → blacklisted access token +
 *   refresh token revoked.
 *
 * The full UserService drags in ClickHouse/Elasticsearch/Vault/CQRS, so the
 * suite provides a thin UserService adapter that delegates the three methods
 * AuthService actually uses to the *real* UserRepository against real Mongo.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import * as bcrypt from 'bcrypt';
import Redis from 'ioredis';
import {
  MongoDBContainer,
  StartedMongoDBContainer,
} from '@testcontainers/mongodb';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { AuthService } from '../../src/modules/auth/services/auth.service';
import { LoginLockoutService } from '../../src/modules/auth/services/login-lockout.service';
import { SessionService } from '../../src/modules/auth/services/session.service';
import { TokenVerifierService } from '../../src/modules/auth/services/token-verifier.service';
import { TENANT_DIRECTORY } from '../../src/common/tenant/tenant-directory.port';
import { UserStatus } from '../../src/modules/user/constants/user.enums';
import {
  REFRESH_TOKEN_KEY,
  TOKEN_REVOKED_KEY,
} from '../../src/modules/auth/constants/auth.constants';
import { toTenantId } from '../../src/common/keyspace';
import { KV } from '../../src/infrastructure/kv/kv.port';
import { RedisKvAdapter } from '../../src/infrastructure/kv/adapters/redis/redis-kv.adapter';
import { RATE_LIMIT } from '../../src/infrastructure/ratelimit/ratelimit.port';
import { RedisRateLimitAdapter } from '../../src/infrastructure/ratelimit/adapters/redis/redis-ratelimit.adapter';
import { UserService } from '../../src/modules/user/services/user.service';
import { UserRepository } from '../../src/modules/user/repositories/user.repository';
import { UserTransformer } from '../../src/modules/user/transformers/user.transformer';
import { User, UserSchema } from '../../src/modules/user/schemas/user.schema';
import { describeWithDocker } from './docker';

const JWT_SECRET = 'integration-test-secret-32-chars!!';

const ACME = toTenantId('acme');
const GLOBEX = toTenantId('globex');

/** Glob over every refresh-token key of one user in tenant acme. */
const refreshTokenPattern = (userId: string) =>
  REFRESH_TOKEN_KEY.forTenant(ACME, userId, 'x').replace(/x$/, '*');

jest.setTimeout(240_000);

describeWithDocker('AuthService (integration)')(
  'AuthService (integration)',
  () => {
    let mongo: StartedMongoDBContainer;
    let redisContainer: StartedRedisContainer;
    let redis: Redis;
    let moduleRef: TestingModule;
    let authService: AuthService;
    let userRepo: UserRepository;
    let jwtService: JwtService;
    let verifier: TokenVerifierService;

    const email = 'alice@example.com';
    const password = 'S3cret-password!';

    beforeAll(async () => {
      [mongo, redisContainer] = await Promise.all([
        new MongoDBContainer('mongo:7').start(),
        new RedisContainer('redis:7-alpine').start(),
      ]);

      redis = new Redis({
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        maxRetriesPerRequest: 3,
      });

      moduleRef = await Test.createTestingModule({
        imports: [
          MongooseModule.forRoot(mongo.getConnectionString(), {
            directConnection: true,
          }),
          MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
          JwtModule.register({
            secret: JWT_SECRET,
            signOptions: { expiresIn: '15m' },
          }),
        ],
        providers: [
          AuthService,
          TokenVerifierService,
          LoginLockoutService,
          UserRepository,
          // AuthService reads JWT_SECRET through ConfigService for the refresh
          // HMAC; without this the module cannot be constructed at all.
          {
            provide: ConfigService,
            useValue: {
              getOrThrow: (key: string) => {
                if (key === 'JWT_SECRET') return JWT_SECRET;
                throw new Error(`Unexpected config key: ${key}`);
              },
              get: () => undefined,
            },
          },
          SessionService,
          {
            provide: TENANT_DIRECTORY,
            useValue: {
              find: (id: string) =>
                Promise.resolve({
                  id,
                  name: id,
                  status: 'active',
                  selfSignup: true,
                }),
            },
          },
          { provide: KV, useFactory: () => new RedisKvAdapter(redis) },
          {
            provide: RATE_LIMIT,
            useFactory: () => new RedisRateLimitAdapter(redis),
          },
          {
            // Thin adapter over the real repository — the only UserService
            // surface AuthService touches.
            provide: UserService,
            inject: [UserRepository],
            useFactory: (repo: UserRepository) => ({
              findByEmailWithPassword: async (t: typeof ACME, e: string) => {
                const user = await repo.findByEmailWithPassword(t, e);
                return user ? UserTransformer.toWithPassword(user) : null;
              },
              findByIdForAuth: async (t: typeof ACME, id: string) => {
                const user = await repo.findById(t, id);
                return user ? UserTransformer.toWithPassword(user) : null;
              },
              findMember: async (t: typeof ACME, id: string) => {
                const user = await repo.findById(t, id);
                return user ? { status: user.status, roles: user.roles } : null;
              },
              recordLogin: async (t: typeof ACME, id: string) =>
                repo.incrementLoginCount(t, id),
            }),
          },
        ],
      }).compile();

      await moduleRef.init();

      authService = moduleRef.get(AuthService);
      userRepo = moduleRef.get(UserRepository);
      jwtService = moduleRef.get(JwtService);
      verifier = moduleRef.get(TokenVerifierService);

      // "register" — create the user with a real bcrypt hash
      await userRepo.create(ACME, {
        name: 'Alice',
        email,
        passwordHash: await bcrypt.hash(password, 10),
      });
    });

    afterAll(async () => {
      await moduleRef?.close();
      redis?.disconnect();
      await Promise.all([mongo?.stop(), redisContainer?.stop()]);
    });

    it('runs the full auth lifecycle against real Redis and Mongo', async () => {
      // ── login → token pair ──────────────────────────────────────────
      const pair = await authService.login(ACME, { email, password });
      expect(pair.accessToken).toBeTruthy();
      expect(pair.refreshToken).toBeTruthy();

      const payload = jwtService.verify<{
        sub: string;
        email: string;
        jti: string;
        exp: number;
        tenantId: string;
      }>(pair.accessToken);
      expect(payload.email).toBe(email);
      expect(payload.jti).toBeTruthy();
      expect(payload.tenantId).toBe('acme');

      // refresh token is stored under the tenant-scoped refresh-token key
      const rtKeys = await redis.keys(refreshTokenPattern(payload.sub));
      expect(rtKeys.length).toBe(1);

      // login recorded (fire-and-forget — poll briefly)
      await new Promise((r) => setTimeout(r, 200));
      const user = await userRepo.findByEmail(ACME, email);
      expect(user!.loginCount).toBe(1);

      // ── refresh → rotation ──────────────────────────────────────────
      const rotated = await authService.refresh(pair.refreshToken);
      expect(rotated.accessToken).not.toBe(pair.accessToken);
      expect(rotated.refreshToken).not.toBe(pair.refreshToken);

      // old refresh token was deleted — replaying it must fail
      await expect(
        authService.refresh(pair.refreshToken),
      ).rejects.toMatchObject({ status: 401 });

      // ── logout → access token blacklisted + refresh token revoked ──
      const rotatedPayload = jwtService.verify<{
        jti: string;
        exp: number;
        sub: string;
      }>(rotated.accessToken);
      expect(await authService.isBlacklisted(rotatedPayload.jti)).toBe(false);

      await authService.logout(
        rotatedPayload.jti,
        rotatedPayload.exp,
        rotated.refreshToken,
      );

      expect(await authService.isBlacklisted(rotatedPayload.jti)).toBe(true);
      expect(
        await redis.exists(TOKEN_REVOKED_KEY.global(rotatedPayload.jti)),
      ).toBe(1);

      // refresh token gone from the store; using it fails
      expect(
        (await redis.keys(refreshTokenPattern(rotatedPayload.sub))).length,
      ).toBe(0);
      await expect(
        authService.refresh(rotated.refreshToken),
      ).rejects.toMatchObject({ status: 401 });
      await expect(verifier.verify(rotated.accessToken)).rejects.toMatchObject({
        code: 'AUTH_TOKEN_REVOKED',
      });
    });

    it('rejects a wrong password and unknown users', async () => {
      await expect(
        authService.login(ACME, { email, password: 'wrong-password' }),
      ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
      await expect(
        authService.login(ACME, { email: 'nobody@example.com', password }),
      ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    });

    it("never signs in to another tenant's account", async () => {
      await expect(
        authService.login(GLOBEX, { email, password }),
      ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    });

    it('ends access and refresh for a suspended account', async () => {
      const bob = await userRepo.create(ACME, {
        name: 'Bob',
        email: 'bob@example.com',
        passwordHash: await bcrypt.hash(password, 4),
      });
      const pair = await authService.login(ACME, {
        email: 'bob@example.com',
        password,
      });
      await expect(verifier.verify(pair.accessToken)).resolves.toMatchObject({
        userId: bob._id.toString(),
        tenantId: 'acme',
      });

      await userRepo.update(ACME, bob._id.toString(), {
        status: UserStatus.INACTIVE,
      });

      await expect(verifier.verify(pair.accessToken)).rejects.toMatchObject({
        code: 'AUTH_ACCOUNT_INACTIVE',
      });
      await expect(
        authService.refresh(pair.refreshToken),
      ).rejects.toMatchObject({ code: 'AUTH_ACCOUNT_INACTIVE' });
    });
  },
);
