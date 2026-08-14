import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Demonstrates pgvector: store a float embedding per user, query by cosine similarity.
 *
 * In production you'd generate embeddings with an LLM (OpenAI text-embedding-3-small,
 * or a local model via Ollama). Here we derive a deterministic 8-dim vector from the
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
          embedding  vector(8),
          updated_at TIMESTAMPTZ DEFAULT now()
        )
      `);
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
   * Derives a simple 8-dim float vector from user profile fields.
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

    return [
      nameHash,
      emailHash,
      ageFactor,
      active,
      loginNorm,
      nameLen,
      emailLen,
      composite,
    ];
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
    } catch {
      /* non-fatal */
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
      const rows = await this.dataSource.query(
        `SELECT target.user_id,
                (source.embedding <=> target.embedding) AS distance
         FROM   user_vectors source
         JOIN   user_vectors target ON target.user_id != source.user_id
         WHERE  source.user_id = $1
         ORDER  BY distance ASC
         LIMIT  $2`,
        [userId, limit],
      );
      return rows.map((r: { user_id: string; distance: string }) => ({
        userId: r.user_id,
        distance: parseFloat(r.distance),
      }));
    } catch {
      return [];
    }
  }
}
