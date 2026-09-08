import { Controller, Inject, Logger } from '@nestjs/common';
import { Audited } from '../../../common/decorators/audited.decorator';
import { extractToken } from '../../../infrastructure/grpc/grpc.utils';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import * as bcrypt from 'bcrypt';
import type Redis from 'ioredis';
import { UserService } from '../../user/services/user.service';
import { REDIS_CLIENT } from '../../../infrastructure/redis/redis.module';

const LOGIN_RATE_LIMIT = 10; // attempts
const LOGIN_RATE_WINDOW_S = 60; // per 60 seconds

interface LoginRequest {
  email: string;
  password: string;
}
interface TokenRequest {
  token: string;
}
interface LoginResponse {
  access_token: string;
}
interface CurrentUserResponse {
  user_id: string;
  email: string;
}

/**
 * Implements the AuthService defined in proto/auth/v1/auth.proto.
 *
 * Test with grpcurl:
 *   grpcurl -plaintext -import-path apps/backend -proto proto/auth/v1/auth.proto \
 *     -d '{"email":"alice@example.com","password":"password123"}' \
 *     localhost:50051 tropis.auth.v1.AuthService/Login
 *
 *   grpcurl -plaintext -import-path apps/backend -proto proto/auth/v1/auth.proto \
 *     -H 'Authorization: Bearer <jwt>' \
 *     localhost:50051 tropis.auth.v1.AuthService/GetCurrentUser
 */
@Controller()
export class GrpcAuthService {
  private readonly logger = new Logger(GrpcAuthService.name);

  private readonly jwtSecret: string;
  private readonly jwtExpiresIn: string;

  constructor(
    private readonly userService: UserService,
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    this.jwtSecret = this.config.getOrThrow<string>('JWT_SECRET');
    this.jwtExpiresIn = this.config.get<string>('JWT_EXPIRES_IN', '15m');
  }

  private async checkRateLimit(email: string): Promise<void> {
    const key = `grpc:login:rl:${email.toLowerCase()}`;
    const count = await this.redis.incr(key).catch(() => 0);
    if (count === 1)
      await this.redis.expire(key, LOGIN_RATE_WINDOW_S).catch(() => undefined);
    if (count > LOGIN_RATE_LIMIT) {
      throw new RpcException({
        code: GrpcStatus.RESOURCE_EXHAUSTED,
        message: 'Too many login attempts — try again in 60 s',
      });
    }
  }

  @Audited('auth.login')
  @GrpcMethod('AuthService', 'Login')
  async login(data: LoginRequest): Promise<LoginResponse> {
    await this.checkRateLimit(data.email);

    const user = await this.userService.findByEmailWithPassword(data.email);
    if (!user)
      throw new RpcException({
        code: GrpcStatus.UNAUTHENTICATED,
        message: 'Invalid credentials',
      });

    const valid = await bcrypt.compare(data.password, user.passwordHash);
    if (!valid)
      throw new RpcException({
        code: GrpcStatus.UNAUTHENTICATED,
        message: 'Invalid credentials',
      });

    // Fire-and-forget with an explicit catch — an unhandled rejection would
    // crash the process.
    this.userService
      .recordLogin(user.id, user.email)
      .catch((err: Error) =>
        this.logger.warn(`recordLogin failed: ${err.message}`),
      );

    const token = jwt.sign(
      {
        sub: user.id,
        email: user.email,
        roles: user.roles ?? [],
        tenantId: user.tenantId,
      },
      this.jwtSecret,
      { expiresIn: this.jwtExpiresIn } as jwt.SignOptions,
    );
    return { access_token: token };
  }

  @GrpcMethod('AuthService', 'GetCurrentUser')
  getCurrentUser(data: TokenRequest, metadata: unknown): CurrentUserResponse {
    try {
      const token = extractToken(data, metadata);
      const payload = jwt.verify(token, this.jwtSecret) as {
        sub: string;
        email: string;
      };
      return { user_id: payload.sub, email: payload.email };
    } catch {
      throw new RpcException({
        code: GrpcStatus.UNAUTHENTICATED,
        message: 'Invalid or expired token',
      });
    }
  }
}
