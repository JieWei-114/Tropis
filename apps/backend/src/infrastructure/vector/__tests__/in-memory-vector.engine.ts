import { capabilityUp, type CapabilityHealth } from '../../capability';
import type { VectorEngine, VectorMatch, VectorMetadata } from '../vector.port';

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / Math.sqrt(na * nb);
}

/** Exact nearest-neighbour engine for unit tests of VectorClient callers. */
export class InMemoryVectorEngine implements VectorEngine {
  private readonly items = new Map<
    string,
    { embedding: number[]; metadata: VectorMetadata }
  >();

  private key(tenantId: string, collection: string, id: string): string {
    return JSON.stringify([tenantId, collection, id]);
  }

  upsert(
    tenantId: string,
    collection: string,
    id: string,
    embedding: number[],
    metadata: VectorMetadata,
  ): Promise<void> {
    this.items.set(this.key(tenantId, collection, id), {
      embedding,
      metadata,
    });
    return Promise.resolve();
  }

  get(tenantId: string, collection: string, id: string) {
    return Promise.resolve(
      this.items.get(this.key(tenantId, collection, id))?.embedding ?? null,
    );
  }

  similar(
    tenantId: string,
    collection: string,
    embedding: number[],
    k: number,
    excludeIds: string[],
  ): Promise<VectorMatch[]> {
    const matches: VectorMatch[] = [];
    for (const [key, item] of this.items) {
      const [t, c, id] = JSON.parse(key) as [string, string, string];
      if (t !== tenantId || c !== collection || excludeIds.includes(id)) {
        continue;
      }
      matches.push({
        id,
        distance: cosineDistance(embedding, item.embedding),
        metadata: item.metadata,
      });
    }
    return Promise.resolve(
      matches.sort((a, b) => a.distance - b.distance).slice(0, k),
    );
  }

  delete(tenantId: string, collection: string, id: string): Promise<void> {
    this.items.delete(this.key(tenantId, collection, id));
    return Promise.resolve();
  }

  health(): Promise<CapabilityHealth> {
    return Promise.resolve(capabilityUp('memory'));
  }
}
