import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { UserEvent, UserEventDocument } from './user-event-store.schema';

@Injectable()
export class UserEventStoreService {
  constructor(
    @InjectModel(UserEvent.name)
    private readonly eventModel: Model<UserEventDocument>,
  ) {}

  async append(
    aggregateId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.appendWithSession(aggregateId, type, payload);
  }

  async appendWithSession(
    aggregateId: string,
    type: string,
    payload: Record<string, unknown>,
    session?: ClientSession,
    schemaVersion = 1,
  ): Promise<void> {
    const lastVersion = await this.eventModel
      .findOne({ aggregateId })
      .sort({ version: -1 })
      .select('version')
      .lean(session ? { session } : {});

    const version = (lastVersion?.version ?? 0) + 1;

    await this.eventModel.create(
      [{ aggregateId, type, payload, version, schemaVersion }],
      session ? { session } : {},
    );
  }

  async getHistory(aggregateId: string): Promise<UserEventDocument[]> {
    return this.eventModel.find({ aggregateId }).sort({ version: 1 }).exec();
  }

  // Replay all events for an aggregate to rebuild its current state.
  // This is the core of event sourcing — state is derived, not stored directly.
  async replay(aggregateId: string): Promise<Record<string, unknown>> {
    const events = await this.getHistory(aggregateId);
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
 * Migrate an old event payload to the current schema before applying it.
 * When a payload shape changes, bump schemaVersion in appendWithSession() and
 * add a migration branch here — old events in the store replay correctly without
 * requiring a backfill migration.
 */
function migratePayload(
  type: string,
  payload: Record<string, unknown>,
  schemaVersion: number,
): Record<string, unknown> {
  // Example: if UserCreated v1 had no `age` field, add a default here
  // if (type === 'UserCreated' && schemaVersion < 2) {
  //   return { age: 0, ...payload };
  // }
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
