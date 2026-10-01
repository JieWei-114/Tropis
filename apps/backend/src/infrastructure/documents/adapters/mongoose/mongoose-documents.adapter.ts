import type { ClientSession, Connection } from 'mongoose';
import { probeCapability, type CapabilityHealth } from '../../../capability';
import type { DocumentsPort, DocumentsTransaction } from '../../documents.port';

/** DocumentsPort over the shared Mongoose connection. */
export class MongooseDocumentsAdapter implements DocumentsPort {
  constructor(private readonly connection: Connection) {}

  async withTransaction<T>(
    work: (tx: DocumentsTransaction) => Promise<T>,
  ): Promise<T> {
    const session = await this.connection.startSession();
    try {
      let result!: T;
      await session.withTransaction(async () => {
        result = await work(asTransaction(session));
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  health(): Promise<CapabilityHealth> {
    return probeCapability('mongodb', async () => {
      const db = this.connection.db;
      if (!db) throw new Error('MongoDB connection is not open');
      await db.command({ ping: 1 });
    });
  }
}

function asTransaction(session: ClientSession): DocumentsTransaction {
  return session as unknown as DocumentsTransaction;
}
