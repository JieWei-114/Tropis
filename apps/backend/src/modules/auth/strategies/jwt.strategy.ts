import { Injectable, UnauthorizedException, Inject } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { UserRole, DEFAULT_TENANT } from '../../user/schemas/user.schema';
import { REDIS_CLIENT } from '../../../infrastructure/redis/redis.module';
import { suspendedKey } from '../../user/constants/user.constants';

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
    // Reject tokens that have been explicitly revoked via logout, and tokens
    // belonging to an account that was suspended after the token was issued.
    // Both markers are read in one round trip.
    const [blacklisted, suspended] = await this.redis
      .multi()
      .exists(payload.jti ? `bl:${payload.jti}` : 'bl:none')
      .exists(suspendedKey(payload.sub))
      .exec()
      .then((res) => [Number(res?.[0]?.[1] ?? 0), Number(res?.[1]?.[1] ?? 0)]);
    if (payload.jti && blacklisted)
      throw new UnauthorizedException('Token revoked');
    if (suspended) throw new UnauthorizedException('Account is not active');

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
