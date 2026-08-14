import { Injectable } from '@nestjs/common';
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
export class UserRepository {
  constructor(@InjectModel(User.name) private readonly model: Model<User>) {}

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

  /** Hard delete — permanently removes. Use only for GDPR erasure or admin tooling. */
  hardDelete(
    id: string,
    tenantId = DEFAULT_TENANT,
  ): Promise<UserDocument | null> {
    return this.model.findOneAndDelete({ _id: id, tenantId }).exec();
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

    const [data, total] = await Promise.all([
      this.model.find(filter).skip(skip).limit(limit).exec(),
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
