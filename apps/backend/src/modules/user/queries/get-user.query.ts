import { IQuery, QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { NotFoundException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type Redis from 'ioredis';
import { UserRepository } from '../repositories/user.repository';
import { UserTransformer } from '../transformers/user.transformer';
import { IUserResponse } from '../interfaces/user.interface';
import { USER_ERROR_CODES } from '../constants/user.constants';
import { REDIS_CLIENT } from '../../../infrastructure/redis/redis.module';
import { TenantContext } from '../../../common/tenant/tenant.context';

const CACHE_TTL = 300;

export class GetUserQuery implements IQuery {
  constructor(public readonly id: string) {}
}

@QueryHandler(GetUserQuery)
export class GetUserHandler implements IQueryHandler<
  GetUserQuery,
  IUserResponse
> {
  constructor(
    private readonly userRepo: UserRepository,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly tenantCtx: TenantContext,
  ) {}

  async execute(query: GetUserQuery): Promise<IUserResponse> {
    const cached = await this.redis.get(`user:${query.id}`);
    if (cached) return JSON.parse(cached) as IUserResponse;

    const user = await this.userRepo.findById(
      query.id,
      this.tenantCtx.tenantId,
    );
    if (!user) throw new NotFoundException(USER_ERROR_CODES.NOT_FOUND);

    const response = UserTransformer.toResponse(user);
    await this.redis.set(
      `user:${query.id}`,
      JSON.stringify(response),
      'EX',
      CACHE_TTL,
    );
    return response;
  }
}
