import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { TenantId } from '../../../common/keyspace';
import { createLogger } from '../../../common/observability/logger';
import { runGlobal } from '../../../common/tenant/tenant.context';
import type { DocumentsTransaction } from '../../../infrastructure/documents/documents.port';
import { TenantScopedRepository } from '../../../infrastructure/documents/tenant-scope';
import { sessionOf } from '../../../infrastructure/documents/transaction';
import { User, UserDocument } from '../schemas/user.schema';

export interface PageResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface CursorPageResult<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

const LIVE = { deletedAt: null } as const;

/**
 * Users of one tenant. Every method takes the TenantId first; the base class
 * adds it to each filter and insert, and live reads also exclude
 * soft-deleted rows (`deletedAt: null`).
 */
@Injectable()
export class UserRepository
  extends TenantScopedRepository<User>
  implements OnModuleInit
{
  private readonly logger = createLogger('user');

  constructor(@InjectModel(User.name) model: Model<User>) {
    super(model);
  }

  /**
   * Reconciles the collection's indexes with the schema, dropping undeclared
   * ones (a stale uniqueness index would keep reserving the emails of
   * soft-deleted users). Failures are logged, never fatal.
   */
  async onModuleInit(): Promise<void> {
    try {
      const dropped = await runGlobal(() => this.model.syncIndexes());
      if (dropped.length) {
        this.logger.info('indexes-dropped', 'Dropped stale user indexes', {
          'db.index.names': dropped.join(','),
        });
      }
    } catch (err) {
      this.logger.warn('index-sync-failed', 'User index sync failed', {}, err);
    }
  }

  create(
    tenantId: TenantId,
    data: Partial<User>,
    tx?: DocumentsTransaction,
  ): Promise<UserDocument> {
    return this.insert(tenantId, data, tx);
  }

  /**
   * Sets the given fields. `endSessions` also bumps tokenVersion, which
   * ends every access and refresh token issued before the change.
   */
  update(
    tenantId: TenantId,
    id: string,
    data: Partial<User>,
    tx?: DocumentsTransaction,
    options: { endSessions?: boolean } = {},
  ): Promise<UserDocument | null> {
    const update: Record<string, unknown> = { $set: data };
    if (options.endSessions) update.$inc = { tokenVersion: 1 };
    return this.findOneAndUpdate(tenantId, { _id: id, ...LIVE }, update, {
      session: sessionOf(tx),
    }).exec();
  }

  /** Replaces the roles and ends the user's sessions (tokenVersion + 1). */
  updateRoles(
    tenantId: TenantId,
    id: string,
    roles: User['roles'],
    tx?: DocumentsTransaction,
  ): Promise<UserDocument | null> {
    return this.update(tenantId, id, { roles }, tx, { endSessions: true });
  }

  /**
   * Writes every other live admin of the tenant inside `tx` and returns how
   * many there are. Two transactions that each demote a different admin
   * then write the same documents and conflict, so the last-admin check
   * cannot be passed by both (write skew).
   */
  async touchOtherAdmins(
    tenantId: TenantId,
    id: string,
    tx?: DocumentsTransaction,
  ): Promise<number> {
    const result = await this.model
      .updateMany(
        this.scope(tenantId, {
          _id: { $ne: id },
          roles: 'admin',
          status: 'active',
          ...LIVE,
        }) as never,
        { $set: { updatedAt: new Date() } } as never,
        { session: sessionOf(tx), timestamps: false } as never,
      )
      .exec();
    return result.modifiedCount;
  }

  /** Status, roles and token version only, read from the store (never cached). */
  findAccess(
    tenantId: TenantId,
    id: string,
  ): Promise<Pick<User, 'status' | 'roles' | 'tokenVersion'> | null> {
    return this.findOne(tenantId, { _id: id, ...LIVE })
      .select({ status: 1, roles: 1, tokenVersion: 1 })
      .lean<Pick<User, 'status' | 'roles' | 'tokenVersion'>>()
      .exec();
  }

  /** Includes passwordHash; for the current-password check only. */
  findByIdWithPassword(
    tenantId: TenantId,
    id: string,
  ): Promise<UserDocument | null> {
    return this.findOne(tenantId, { _id: id, ...LIVE })
      .select('+passwordHash')
      .exec();
  }

  /** Soft delete: sets deletedAt; the document stays for audit. */
  delete(
    tenantId: TenantId,
    id: string,
    tx?: DocumentsTransaction,
  ): Promise<UserDocument | null> {
    return this.findOneAndUpdate(
      tenantId,
      { _id: id, ...LIVE },
      { deletedAt: new Date() },
      { session: sessionOf(tx) },
    ).exec();
  }

  /**
   * Permanently removes the document. Writes no outbox event, so search and
   * vector copies survive; a GDPR erasure path must emit user.deleted too.
   */
  hardDelete(tenantId: TenantId, id: string): Promise<UserDocument | null> {
    return this.findOneAndDelete(tenantId, { _id: id }).exec();
  }

  findByIds(tenantId: TenantId, ids: string[]): Promise<UserDocument[]> {
    if (!ids.length) return Promise.resolve([]);
    return this.find(tenantId, { _id: { $in: ids }, ...LIVE }).exec();
  }

  async incrementLoginCount(tenantId: TenantId, id: string): Promise<void> {
    await this.updateOne(
      tenantId,
      { _id: id, ...LIVE },
      { $inc: { loginCount: 1 } },
    ).exec();
  }

  /** Offset page, newest first; sorting keeps skip/limit pages disjoint. */
  async findAll(
    tenantId: TenantId,
    page: number,
    limit: number,
  ): Promise<PageResult<UserDocument>> {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.find(tenantId, LIVE)
        .sort({ _id: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      this.countDocuments(tenantId, LIVE).exec(),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /** Keyset page by _id: stable under inserts and deletes, no count query. */
  async findPage(
    tenantId: TenantId,
    limit: number,
    cursor?: string,
  ): Promise<CursorPageResult<UserDocument>> {
    const filter: Record<string, unknown> = { ...LIVE };
    if (cursor) {
      filter['_id'] = {
        $gt: Buffer.from(cursor, 'base64url').toString('utf8'),
      };
    }
    const data = await this.find(tenantId, filter)
      .sort({ _id: 1 })
      .limit(limit + 1)
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

  findAllRaw(tenantId: TenantId): Promise<UserDocument[]> {
    return this.find(tenantId, LIVE).exec();
  }

  findById(
    tenantId: TenantId,
    id: string,
    tx?: DocumentsTransaction,
  ): Promise<UserDocument | null> {
    return this.findOne(tenantId, { _id: id, ...LIVE })
      .session(sessionOf(tx) ?? null)
      .exec();
  }

  findByEmail(tenantId: TenantId, email: string): Promise<UserDocument | null> {
    return this.findOne(tenantId, { email, ...LIVE }).exec();
  }

  /** Includes passwordHash; for AuthService only. */
  findByEmailWithPassword(
    tenantId: TenantId,
    email: string,
  ): Promise<UserDocument | null> {
    return this.findOne(tenantId, { email, ...LIVE })
      .select('+passwordHash')
      .exec();
  }

  findByProvider(
    tenantId: TenantId,
    provider: string,
    providerId: string,
  ): Promise<UserDocument | null> {
    return this.findOne(tenantId, { provider, providerId, ...LIVE }).exec();
  }
}
