import { IQuery, QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { UserRepository } from '../repositories/user.repository';
import { UserTransformer } from '../transformers/user.transformer';
import { IUserResponse } from '../interfaces/user.interface';
import {
  USER_ERROR_CODES,
  USER_PROFILE_CACHE,
  USER_PROFILE_CACHE_TTL_SECONDS,
} from '../constants/user.constants';
import {
  CACHE,
  type CachePort,
} from '../../../infrastructure/cache/cache.port';
import { TenantContext } from '../../../common/tenant/tenant.context';

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
    @Inject(CACHE) private readonly cache: CachePort,
    private readonly tenantCtx: TenantContext,
  ) {}

  /**
   * Cache-aside with single-flight. The key is tenant-scoped, so a cached
   * profile is only ever returned to the tenant it was loaded for.
   */
  execute(query: GetUserQuery): Promise<IUserResponse> {
    const tenant = this.tenantCtx.tenant;
    return this.cache.getOrLoad(
      USER_PROFILE_CACHE.forTenant(tenant, query.id),
      USER_PROFILE_CACHE_TTL_SECONDS,
      async () => {
        const user = await this.userRepo.findById(tenant, query.id);
        if (!user) throw new AppError(USER_ERROR_CODES.NOT_FOUND);
        return UserTransformer.toResponse(user);
      },
    );
  }
}
