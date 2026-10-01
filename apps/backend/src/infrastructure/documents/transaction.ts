import type { ClientSession } from 'mongoose';
import type { DocumentsTransaction } from './documents.port';

/** The driver session behind a transaction, for repository calls. */
export function sessionOf(
  tx: DocumentsTransaction | undefined,
): ClientSession | undefined {
  return tx as unknown as ClientSession | undefined;
}
