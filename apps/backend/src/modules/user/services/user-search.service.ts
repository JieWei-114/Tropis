import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import type { TenantId } from '../../../common/keyspace';
import { createLogger } from '../../../common/observability/logger';
import { TenantContext } from '../../../common/tenant/tenant.context';
import { isValidObjectId } from '../../../common/utils/object-id';
import {
  SEARCH,
  type SearchPort,
} from '../../../infrastructure/search/search.port';
import {
  USER_ERROR_CODES,
  USER_SEARCH_INDEX,
} from '../constants/user.constants';
import type { IUserResponse } from '../interfaces/user.interface';
import { UserRepository } from '../repositories/user.repository';
import type { UserDocument } from '../schemas/user.schema';
import { UserTransformer } from '../transformers/user.transformer';
import { UserSimilarityService } from './user-similarity.service';

/**
 * User discovery over the search and vector capabilities: full-text search,
 * similar users, and the index/vector projections the user consumer keeps
 * current. Separate from UserService so a role that only resolves users
 * (the internal tier) boots neither store.
 */
@Injectable()
export class UserSearchService implements OnModuleInit {
  private readonly logger = createLogger('user');

  constructor(
    @Inject(SEARCH) private readonly searchPort: SearchPort,
    private readonly similarity: UserSimilarityService,
    private readonly userRepo: UserRepository,
    private readonly tenantCtx: TenantContext,
  ) {}

  async onModuleInit() {
    try {
      await this.searchPort.ensureIndex(USER_SEARCH_INDEX, {
        id: { type: 'keyword' },
        name: { type: 'text', analyzer: 'standard' },
        email: { type: 'text', analyzer: 'standard' },
        status: { type: 'keyword' },
        age: { type: 'integer' },
      });
    } catch (err) {
      this.logger.warn(
        'search-index-init-failed',
        'User search index init failed',
        {},
        err,
      );
    }
  }

  /** Full-text search over this tenant's users only (the port filters by tenant). */
  async search(query: string, size = 10): Promise<IUserResponse[]> {
    const result = await this.searchPort.query<
      IUserResponse & Record<string, unknown>
    >(this.tenantCtx.tenant, USER_SEARCH_INDEX, query, {
      fields: ['name^2', 'email'],
      fuzzy: true,
      size,
    });
    return result.hits;
  }

  /** Users closest to `userId`, in distance order. */
  async findSimilar(userId: string, limit = 5): Promise<IUserResponse[]> {
    if (!isValidObjectId(userId)) {
      throw new AppError(USER_ERROR_CODES.NOT_FOUND);
    }
    const similar = await this.similarity.findSimilar(
      this.tenantCtx.tenant,
      userId,
      limit,
    );
    if (!similar.length) return [];
    // One query for all of them: a per-row lookup is an N+1 that can
    // exhaust the connection pool from a single call.
    const found = await this.userRepo.findByIds(
      this.tenantCtx.tenant,
      similar.map((s) => s.userId),
    );
    const byId = new Map(found.map((u) => [u._id.toString(), u]));
    return similar
      .map((s) => byId.get(s.userId))
      .filter((u): u is NonNullable<typeof u> => Boolean(u))
      .map((u) => UserTransformer.toResponse(u));
  }

  /** The search and vector writes for a user's current state. */
  indexSinks(tenantId: TenantId, userId: string, u: UserDocument) {
    return [
      {
        name: 'search',
        run: this.searchPort.index(tenantId, USER_SEARCH_INDEX, userId, {
          id: userId,
          name: u.name ?? '',
          email: u.email ?? '',
          status: u.status,
          age: u.age ?? 0,
        }),
      },
      {
        name: 'vector',
        run: this.similarity.upsert(tenantId, userId, {
          name: u.name ?? '',
          email: u.email ?? '',
          age: u.age ?? 0,
          status: u.status,
          loginCount: u.loginCount ?? 0,
        }),
      },
    ];
  }

  /** The search and vector deletes for a removed user. */
  removeSinks(tenantId: TenantId, userId: string) {
    return [
      {
        name: 'search',
        run: this.searchPort.remove(tenantId, USER_SEARCH_INDEX, userId),
      },
      { name: 'vector', run: this.similarity.remove(tenantId, userId) },
    ];
  }
}
