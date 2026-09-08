import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

/** Embedding width — matches the user_vectors.embedding column (vector(384)). */
const EMBEDDING_DIM = 384;

/**
 * Demonstrates pgvector: store a float embedding per user, query by cosine similarity.
 *
 * In production you'd generate embeddings with an LLM (OpenAI text-embedding-3-small,
 * or a local model via Ollama). Here we derive a deterministic vector from the
 * user's profile so the demo works without any external API calls.
 *
 * Why pgvector over Elasticsearch for this?
 *   ES kNN search works on dense vectors but requires mapping them upfront and a
 *   dedicated kNN index type.  pgvector sits alongside your relational data — you can
 *   JOIN vectors with regular WHERE clauses, which is powerful for filtered similarity
 *   (e.g. "find similar users who are also active").
 */
@Injectable()
export class UserVectorService implements OnModuleInit {
  private readonly logger = new Logger(UserVectorService.name);

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit() {
    try {
      await this.dataSource.query(`CREATE EXTENSION IF NOT EXISTS vector`);
      await this.dataSource.query(`
        CREATE TABLE IF NOT EXISTS user_vectors (
          user_id    TEXT PRIMARY KEY,
          embedding  vector(384),
          updated_at TIMESTAMPTZ DEFAULT now()
        )
      `);
      // CREATE TABLE IF NOT EXISTS is a no-op against an existing table, so it
      // cannot correct an embedding column of a different width — every upsert
      // would fail on a dimension mismatch. Reconcile the width before indexing.
      await this.ensureEmbeddingWidth();
      await this.dataSource.query(`
        CREATE INDEX IF NOT EXISTS user_vectors_embedding_idx
        ON user_vectors
        USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 10)
      `);
      this.logger.log('pgvector user_vectors table ready');
    } catch (err) {
      this.logger.warn(
        'pgvector init failed — similarity search unavailable',
        (err as Error).message,
      );
    }
  }

  /**
   * Brings an existing `embedding` column to EMBEDDING_DIM.
   *
   * pgvector cannot change a column's dimension in place while data is present,
   * and the stored vectors are derived (not source data), so the rows are
   * dropped and repopulated on the next upsert.
   */
  private async ensureEmbeddingWidth(): Promise<void> {
    const rows: { dim: number }[] = await this.dataSource.query(
      `SELECT atttypmod AS dim
       FROM   pg_attribute
       WHERE  attrelid = 'user_vectors'::regclass AND attname = 'embedding'`,
    );

    const current = rows[0]?.dim;
    if (current === undefined || current === EMBEDDING_DIM) return;

    this.logger.warn(
      `user_vectors.embedding is vector(${current}); migrating to vector(${EMBEDDING_DIM})`,
    );
    await this.dataSource.query(
      `DROP INDEX IF EXISTS user_vectors_embedding_idx`,
    );
    await this.dataSource.query(`TRUNCATE user_vectors`);
    await this.dataSource.query(
      `ALTER TABLE user_vectors ALTER COLUMN embedding TYPE vector(${EMBEDDING_DIM})`,
    );
  }

  /**
   * Derives a deterministic EMBEDDING_DIM-wide vector from profile fields:
   * 8 real signal features up front, zero-padded to the column width.
   * In production: call an embedding API here instead.
   */
  private buildEmbedding(profile: {
    name: string;
    email: string;
    age: number;
    status: string;
    loginCount: number;
  }): number[] {
    const nameHash =
      [...profile.name].reduce((s, c) => s + c.charCodeAt(0), 0) / 10000;
    const emailHash =
      [...profile.email].reduce((s, c) => s + c.charCodeAt(0), 0) / 100000;
    const ageFactor = (profile.age || 25) / 100;
    const active = profile.status === 'active' ? 1.0 : 0.0;
    const loginNorm = Math.min(profile.loginCount / 100, 1.0);
    const nameLen = Math.min(profile.name.length / 30, 1.0);
    const emailLen = Math.min(profile.email.length / 50, 1.0);
    const composite = (nameHash + emailHash + ageFactor) / 3;

    // The table stores vector(384) (matching a real MiniLM-style embedding
    // width). We place the 8 signal features up front and zero-pad the rest —
    // cosine ordering depends only on the non-zero dimensions.
    const signal = [
      nameHash,
      emailHash,
      ageFactor,
      active,
      loginNorm,
      nameLen,
      emailLen,
      composite,
    ];
    return [...signal, ...new Array(EMBEDDING_DIM - signal.length).fill(0)];
  }

  async upsertVector(
    userId: string,
    profile: {
      name: string;
      email: string;
      age: number;
      status: string;
      loginCount: number;
    },
  ): Promise<void> {
    try {
      const vec = this.buildEmbedding(profile);
      const pgVec = `[${vec.join(',')}]`;
      await this.dataSource.query(
        `INSERT INTO user_vectors (user_id, embedding, updated_at)
         VALUES ($1, $2::vector, now())
         ON CONFLICT (user_id) DO UPDATE
           SET embedding = EXCLUDED.embedding, updated_at = now()`,
        [userId, pgVec],
      );
    } catch (err) {
      // Non-fatal, but log it: swallowing this hides a dimension mismatch,
      // which leaves user_vectors empty with no symptom.
      this.logger.warn(`Vector upsert failed: ${(err as Error).message}`);
    }
  }

  async deleteVector(userId: string): Promise<void> {
    try {
      await this.dataSource.query(
        `DELETE FROM user_vectors WHERE user_id = $1`,
        [userId],
      );
    } catch {
      /* non-fatal */
    }
  }

  /**
   * Returns the N most similar users to the given userId.
   * Uses cosine distance (<=>), lower = more similar.
   */
  async findSimilar(
    userId: string,
    limit = 5,
  ): Promise<{ userId: string; distance: number }[]> {
    try {
      // Two steps on purpose: ORDER BY needs a constant probe vector to be
      // index-eligible, so the vector is fetched first. A self-join comparing
      // two table columns (`source.embedding <=> target.embedding`) cannot use
      // the ivfflat index and degenerates into a full nested scan plus a sort
      // of every pair.
      const src = await this.dataSource.query(
        `SELECT embedding FROM user_vectors WHERE user_id = $1`,
        [userId],
      );
      if (!src.length) return [];

      const rows = await this.dataSource.query(
        `SELECT user_id, (embedding <=> $1::vector) AS distance
         FROM   user_vectors
         WHERE  user_id <> $2
         ORDER  BY embedding <=> $1::vector
         LIMIT  $3`,
        [src[0].embedding, userId, limit],
      );

      return rows.map((r) => ({
        userId: r.user_id,
        distance: parseFloat(r.distance),
      }));
    } catch (err) {
      this.logger.warn(`findSimilar failed: ${(err as Error).message}`);
      return [];
    }
  }
}
