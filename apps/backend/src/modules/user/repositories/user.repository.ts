import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { User, UserDocument, DEFAULT_TENANT } from '../schemas/user.schema';

export interface PageResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface CursorPageResult<T> {
  data: T[];
  nextCursor: string | null; // base64url-encoded last _id; null = no more pages
  hasMore: boolean;
}

// Base filter applied to every query — excludes soft-deleted records
const ACTIVE = { deletedAt: null } as const;

@Injectable()
export class UserRepository implements OnModuleInit {
  private readonly logger = new Logger(UserRepository.name);

  constructor(@InjectModel(User.name) private readonly model: Model<User>) {}

  /**
   * Reconciles the collection's indexes with the schema.
   *
   * Mongoose CREATES declared indexes automatically but never DROPS undeclared
   * ones, and syncIndexes() is what removes them. The email uniqueness
   * constraint is `{tenantId, email}` with a `partialFilterExpression:
   * { deletedAt: null }`; any undeclared uniqueness index left on the
   * collection keeps reserving the email addresses of soft-deleted users.
   *
   * Safe to run repeatedly and a no-op once converged; failures are logged,
   * never fatal, since a stale index degrades behaviour rather than breaking
   * startup.
   */
  async onModuleInit(): Promise<void> {
    try {
      const dropped = await this.model.syncIndexes();
      if (dropped.length) {
        this.logger.log(`Dropped stale user indexes: ${dropped.join(', ')}`);
      }
    } catch (err) {
      this.logger.warn(`User index sync failed: ${(err as Error).message}`);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Every query is scoped to a tenant. Falls back to 'default' if not supplied. */
  private tenant(tenantId = DEFAULT_TENANT) {
    return { tenantId, ...ACTIVE };
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  create(data: Partial<User>): Promise<UserDocument> {
    return this.model.create({ tenantId: DEFAULT_TENANT, ...data });
  }

  async createWithSession(
    data: Partial<User>,
    session: ClientSession,
  ): Promise<UserDocument> {
    const [doc] = await this.model.create(
      [{ tenantId: DEFAULT_TENANT, ...data }],
      { session },
    );
    return doc;
  }

  update(
    id: string,
    data: Partial<User>,
    tenantId = DEFAULT_TENANT,
  ): Promise<UserDocument | null> {
    return this.model
      .findOneAndUpdate({ _id: id, ...this.tenant(tenantId) }, data, {
        new: true,
      })
      .exec();
  }

  updateWithSession(
    id: string,
    data: Partial<User>,
    session: ClientSession,
    tenantId = DEFAULT_TENANT,
  ): Promise<UserDocument | null> {
    return this.model
      .findOneAndUpdate({ _id: id, ...this.tenant(tenantId) }, data, {
        new: true,
        session,
      })
      .exec();
  }

  /**
   * Soft delete — sets deletedAt instead of removing the document.
   * Document stays in MongoDB for audit / foreign-key integrity / GDPR staging.
   */
  delete(id: string, tenantId = DEFAULT_TENANT): Promise<UserDocument | null> {
    return this.model
      .findOneAndUpdate(
        { _id: id, ...this.tenant(tenantId) },
        { deletedAt: new Date() },
        { new: true },
      )
      .exec();
  }

  deleteWithSession(
    id: string,
    session: ClientSession,
    tenantId = DEFAULT_TENANT,
  ): Promise<UserDocument | null> {
    return this.model
      .findOneAndUpdate(
        { _id: id, ...this.tenant(tenantId) },
        { deletedAt: new Date() },
        { new: true, session },
      )
      .exec();
  }

  /**
   * Hard delete — permanently removes the document.
   *
   * Only reachable from admin tooling and the integration suite; no
   * application code path calls it. Note before adding one: unlike delete(),
   * this writes no outbox event, so the downstream copies are NOT cleaned up —
   * the user's name and email survive in Elasticsearch and their embedding in
   * pgvector. A GDPR erasure path must emit user.deleted (or purge those
   * directly), otherwise it defeats its own purpose.
   */
  hardDelete(
    id: string,
    tenantId = DEFAULT_TENANT,
  ): Promise<UserDocument | null> {
    return this.model.findOneAndDelete({ _id: id, tenantId }).exec();
  }

  /** Batched lookup — one query for many ids, in place of an N+1 loop. */
  findByIds(ids: string[], tenantId = DEFAULT_TENANT): Promise<UserDocument[]> {
    if (!ids.length) return Promise.resolve([]);
    return this.model
      .find({ _id: { $in: ids }, ...this.tenant(tenantId) })
      .exec();
  }

  async incrementLoginCount(id: string): Promise<void> {
    await this.model
      .updateOne({ _id: id, ...ACTIVE }, { $inc: { loginCount: 1 } })
      .exec();
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  /**
   * Paginated list scoped to a tenant.
   * countDocuments() and find() run in parallel — response time = max(count, find).
   */
  async findAll(
    page: number,
    limit: number,
    tenantId = DEFAULT_TENANT,
  ): Promise<PageResult<UserDocument>> {
    const skip = (page - 1) * limit;
    const filter = this.tenant(tenantId);

    // Sort is required, not cosmetic: skip/limit over an unsorted scan lets a
    // document appear on two pages or none at all. Newest-first also means a
    // just-created user shows up at the top of page 1 instead of being invisible
    // past the limit.
    const [data, total] = await Promise.all([
      this.model.find(filter).sort({ _id: -1 }).skip(skip).limit(limit).exec(),
      this.model.countDocuments(filter).exec(),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Cursor-based pagination — stable under inserts/deletes, no COUNT query.
   * Pass cursor=undefined for the first page; subsequent pages pass the
   * nextCursor returned by the previous call.
   */
  async findPage(
    limit: number,
    tenantId = DEFAULT_TENANT,
    cursor?: string,
  ): Promise<CursorPageResult<UserDocument>> {
    const filter: Record<string, unknown> = this.tenant(tenantId);
    if (cursor) {
      const lastId = Buffer.from(cursor, 'base64url').toString('utf8');
      filter['_id'] = { $gt: lastId };
    }

    const data = await this.model
      .find(filter)
      .sort({ _id: 1 })
      .limit(limit + 1) // fetch one extra to detect hasMore
      .exec();

    const hasMore = data.length > limit;
    if (hasMore) data.pop();

    const nextCursor =
      hasMore && data.length > 0
        ? Buffer.from(data[data.length - 1]._id.toString()).toString(
            'base64url',
          )
        : null;

    return { data, nextCursor, hasMore };
  }

  // Non-paginated — used by gRPC FindAll
  findAllRaw(tenantId = DEFAULT_TENANT): Promise<UserDocument[]> {
    return this.model.find(this.tenant(tenantId)).exec();
  }

  findById(
    id: string,
    tenantId = DEFAULT_TENANT,
  ): Promise<UserDocument | null> {
    return this.model.findOne({ _id: id, ...this.tenant(tenantId) }).exec();
  }

  findByEmail(
    email: string,
    tenantId = DEFAULT_TENANT,
  ): Promise<UserDocument | null> {
    return this.model.findOne({ email, ...this.tenant(tenantId) }).exec();
  }

  // Explicitly selects passwordHash — only for AuthService
  findByEmailWithPassword(
    email: string,
    tenantId = DEFAULT_TENANT,
  ): Promise<UserDocument | null> {
    return this.model
      .findOne({ email, ...this.tenant(tenantId) })
      .select('+passwordHash')
      .exec();
  }

  // OAuth login — find by provider identity within the tenant
  findByProvider(
    provider: string,
    providerId: string,
    tenantId = DEFAULT_TENANT,
  ): Promise<UserDocument | null> {
    return this.model
      .findOne({ provider, providerId, ...this.tenant(tenantId) })
      .exec();
  }
}
