import { Injectable, UnauthorizedException, Inject } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { UserRole, DEFAULT_TENANT } from '../../user/schemas/user.schema';
import { REDIS_CLIENT } from '../../../infrastructure/redis/redis.module';

export interface JwtPayload {
  sub: string;
  email: string;
  roles: UserRole[];
  tenantId: string;
  jti: string;
  exp: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload) {
    // Reject tokens that have been explicitly revoked via logout
    if (payload.jti) {
      const blacklisted = await this.redis.exists(`bl:${payload.jti}`);
      if (blacklisted) throw new UnauthorizedException('Token revoked');
    }

    return {
      userId: payload.sub,
      email: payload.email,
      roles: payload.roles ?? [],
      tenantId: payload.tenantId ?? DEFAULT_TENANT,
      jti: payload.jti,
      exp: payload.exp,
    };
  }
}
