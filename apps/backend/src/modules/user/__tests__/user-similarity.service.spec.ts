import { toTenantId } from '../../../common/keyspace';
import { VECTOR_DIMENSIONS } from '../../../infrastructure/vector/vector.port';
import { VectorClient } from '../../../infrastructure/vector/vector.client';
import { InMemoryVectorEngine } from '../../../infrastructure/vector/__tests__/in-memory-vector.engine';
import {
  buildEmbedding,
  UserSimilarityService,
} from '../services/user-similarity.service';

describe('UserSimilarityService', () => {
  const ACME = toTenantId('acme');
  const GLOBEX = toTenantId('globex');
  const profile = (name: string, age: number) => ({
    name,
    email: `${name.toLowerCase()}@example.com`,
    age,
    status: 'active',
    loginCount: 3,
  });
  let service: UserSimilarityService;

  beforeEach(() => {
    service = new UserSimilarityService(
      new VectorClient(new InMemoryVectorEngine()),
    );
  });

  it('builds an embedding of the stored width', () => {
    expect(buildEmbedding(profile('Ada', 36))).toHaveLength(VECTOR_DIMENSIONS);
  });

  it('finds similar users of the same tenant only, excluding the probe', async () => {
    await service.upsert(ACME, 'ada', profile('Ada', 36));
    await service.upsert(ACME, 'ava', profile('Ava', 35));
    await service.upsert(GLOBEX, 'amy', profile('Amy', 36));

    const similar = await service.findSimilar(ACME, 'ada', 5);
    expect(similar.map((s) => s.userId)).toEqual(['ava']);
  });

  it('returns nothing for a user without a stored vector', async () => {
    await expect(service.findSimilar(ACME, 'nobody')).resolves.toEqual([]);
  });

  it('rejects write failures so the projection redelivers, and degrades reads', async () => {
    const failing = new UserSimilarityService({
      upsert: () => Promise.reject(new Error('down')),
      get: () => Promise.reject(new Error('down')),
      similar: () => Promise.reject(new Error('down')),
      delete: () => Promise.reject(new Error('down')),
      health: () => Promise.reject(new Error('down')),
    });
    await expect(failing.upsert(ACME, 'a', profile('A', 1))).rejects.toThrow(
      'down',
    );
    await expect(failing.remove(ACME, 'a')).rejects.toThrow('down');
    await expect(failing.findSimilar(ACME, 'a')).resolves.toEqual([]);
  });
});
