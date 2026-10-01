import type { HealthCheckable } from '../capability';

/**
 * Documents — the document store behind every module's repositories.
 *
 * Repositories are the documents adapter layer of their own module: they keep
 * `@InjectModel` and Mongoose models, because a query-shaped port would only
 * re-implement the ODM. What this capability owns is the root connection
 * (adapters/mongoose), the unit of work and health; swapping the store means
 * rewriting the repositories, which is why no second adapter or `disabled`
 * exists.
 */
export const DOCUMENTS = Symbol('DOCUMENTS');

declare const TRANSACTION: unique symbol;

/** An open transaction; repositories pass it with every write inside it. */
export interface DocumentsTransaction {
  readonly [TRANSACTION]: true;
}

export interface DocumentsPort extends HealthCheckable {
  /**
   * Runs `work` in one transaction: every write that is passed `tx` commits
   * or rolls back together. A transient conflict reruns `work`, so it must
   * not have side effects outside the store.
   */
  withTransaction<T>(
    work: (tx: DocumentsTransaction) => Promise<T>,
  ): Promise<T>;
}
