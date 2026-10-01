import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { TenantId } from '../../../common/keyspace';
import type { DocumentsTransaction } from '../../../infrastructure/documents/documents.port';
import { TenantScopedRepository } from '../../../infrastructure/documents/tenant-scope';
import { sessionOf } from '../../../infrastructure/documents/transaction';
import { UserEvent, UserEventDocument } from './user-event-store.schema';

@Injectable()
export class UserEventStoreService extends TenantScopedRepository<UserEvent> {
  constructor(@InjectModel(UserEvent.name) model: Model<UserEvent>) {
    super(model);
  }

  async append(
    tenantId: TenantId,
    aggregateId: string,
    type: string,
    payload: Record<string, unknown>,
    tx?: DocumentsTransaction,
    schemaVersion = 1,
  ): Promise<void> {
    const lastVersion = await this.findOne(tenantId, { aggregateId })
      .sort({ version: -1 })
      .select('version')
      .session(sessionOf(tx) ?? null)
      .lean();

    const version = (lastVersion?.version ?? 0) + 1;

    await this.insert(
      tenantId,
      { aggregateId, type, payload, version, schemaVersion },
      tx,
    );
  }

  async getHistory(
    tenantId: TenantId,
    aggregateId: string,
  ): Promise<UserEventDocument[]> {
    return this.find(tenantId, { aggregateId }).sort({ version: 1 }).exec();
  }

  /** Replays an aggregate's events in order to rebuild its current state. */
  async replay(
    tenantId: TenantId,
    aggregateId: string,
  ): Promise<Record<string, unknown>> {
    const events = await this.getHistory(tenantId, aggregateId);
    let state: Record<string, unknown> = {};

    for (const event of events) {
      const migratedPayload = migratePayload(
        event.type,
        event.payload,
        event.schemaVersion,
      );
      state = applyEvent(state, event.type, migratedPayload);
    }

    return state;
  }
}

/**
 * Brings an old payload to the current schema before it is applied. Bump
 * schemaVersion in appendWithSession() when a payload shape changes and add
 * the branch here, so old events replay without a backfill.
 */
function migratePayload(
  type: string,
  payload: Record<string, unknown>,
  schemaVersion: number,
): Record<string, unknown> {
  void type;
  void schemaVersion;
  return payload;
}

function applyEvent(
  state: Record<string, unknown>,
  type: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  switch (type) {
    case 'UserCreated':
      return { ...payload };
    case 'UserUpdated':
      return { ...state, ...payload };
    case 'UserDeleted':
      return { ...state, deletedAt: new Date().toISOString() };
    default:
      return state;
  }
}
