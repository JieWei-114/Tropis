/**
 * Auth integration test — real Redis (redis:7-alpine) + real MongoDB (mongo:7,
 * single-node replica set via @testcontainers/mongodb).
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
import { MongooseModule } from '@nestjs/mongoose';
import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import Redis from 'ioredis';
import {
  MongoDBContainer,
  StartedMongoDBContainer,
} from '@testcontainers/mongodb';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { AuthService } from '../../src/modules/auth/services/auth.service';
import { LoginLockoutService } from '../../src/modules/auth/services/login-lockout.service';
import { SessionService } from '../../src/infrastructure/aerospike/session.service';
import { UserService } from '../../src/modules/user/services/user.service';
import { UserRepository } from '../../src/modules/user/repositories/user.repository';
import { UserTransformer } from '../../src/modules/user/transformers/user.transformer';
import { User, UserSchema } from '../../src/modules/user/schemas/user.schema';
import { REDIS_CLIENT } from '../../src/infrastructure/redis/redis.module';
import { describeWithDocker } from './docker';

const JWT_SECRET = 'integration-test-secret-32-chars!!';

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
          LoginLockoutService,
          UserRepository,
          // Real SessionService in degraded (null-client) mode — Aerospike is
          // not part of this integration harness, and the service no-ops.
          { provide: SessionService, useValue: new SessionService(null) },
          { provide: REDIS_CLIENT, useValue: redis },
          {
            // Thin adapter over the real repository — the only UserService
            // surface AuthService touches.
            provide: UserService,
            inject: [UserRepository],
            useFactory: (repo: UserRepository) => ({
              findByEmailWithPassword: async (e: string) => {
                const user = await repo.findByEmailWithPassword(e);
                return user ? UserTransformer.toWithPassword(user) : null;
              },
              findByIdForAuth: async (id: string) => {
                const user = await repo.findById(id);
                return user ? UserTransformer.toWithPassword(user) : null;
              },
              recordLogin: async (id: string) => repo.incrementLoginCount(id),
            }),
          },
        ],
      }).compile();

      await moduleRef.init();

      authService = moduleRef.get(AuthService);
      userRepo = moduleRef.get(UserRepository);
      jwtService = moduleRef.get(JwtService);

      // "register" — create the user with a real bcrypt hash
      await userRepo.create({
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
      const pair = await authService.login({ email, password });
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
      expect(payload.tenantId).toBe('default');

      // refresh token is stored in Redis under rt:{userId}:{tokenId}
      const rtKeys = await redis.keys(`rt:${payload.sub}:*`);
      expect(rtKeys.length).toBe(1);

      // login recorded (fire-and-forget — poll briefly)
      await new Promise((r) => setTimeout(r, 200));
      const user = await userRepo.findByEmail(email);
      expect(user!.loginCount).toBe(1);

      // ── refresh → rotation ──────────────────────────────────────────
      const rotated = await authService.refresh(pair.refreshToken);
      expect(rotated.accessToken).not.toBe(pair.accessToken);
      expect(rotated.refreshToken).not.toBe(pair.refreshToken);

      // old refresh token was deleted — replaying it must fail
      await expect(authService.refresh(pair.refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );

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
      expect(await redis.exists(`bl:${rotatedPayload.jti}`)).toBe(1);

      // refresh token gone from Redis; using it fails
      expect((await redis.keys(`rt:${rotatedPayload.sub}:*`)).length).toBe(0);
      await expect(authService.refresh(rotated.refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a wrong password and unknown users', async () => {
      await expect(
        authService.login({ email, password: 'wrong-password' }),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        authService.login({ email: 'nobody@example.com', password }),
      ).rejects.toThrow(UnauthorizedException);
    });
  },
);
