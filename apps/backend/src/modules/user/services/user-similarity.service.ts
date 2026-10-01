import { Inject, Injectable } from '@nestjs/common';
import type { TenantId } from '../../../common/keyspace';
import { createLogger } from '../../../common/observability/logger';
import {
  VECTOR,
  VECTOR_DIMENSIONS,
  type VectorPort,
} from '../../../infrastructure/vector/vector.port';
import { USER_VECTOR_COLLECTION } from '../constants/user.constants';

export interface UserProfileSignal {
  name: string;
  email: string;
  age: number;
  status: string;
  loginCount: number;
}

/**
 * User similarity over the vector capability.
 *
 * In production the embedding would come from a model (a hosted embedding
 * API or a local one). Here it is derived deterministically from the profile
 * so the demo works without external calls.
 *
 * upsert() and remove() reject on a vector-store failure, so the user event
 * projection that runs them is redelivered instead of leaving a vector lost
 * or stale (a disabled capability, CapabilityDisabledError, is not counted
 * as a failure there). findSimilar() degrades to an empty result.
 */
@Injectable()
export class UserSimilarityService {
  private readonly logger = createLogger('user');

  constructor(@Inject(VECTOR) private readonly vectors: VectorPort) {}

  async upsert(
    tenantId: TenantId,
    userId: string,
    profile: UserProfileSignal,
  ): Promise<void> {
    await this.vectors.upsert(
      tenantId,
      USER_VECTOR_COLLECTION,
      userId,
      buildEmbedding(profile),
    );
  }

  async remove(tenantId: TenantId, userId: string): Promise<void> {
    await this.vectors.delete(tenantId, USER_VECTOR_COLLECTION, userId);
  }

  /** The `limit` users most similar to `userId` in the same tenant, nearest first. */
  async findSimilar(
    tenantId: TenantId,
    userId: string,
    limit = 5,
  ): Promise<{ userId: string; distance: number }[]> {
    try {
      const probe = await this.vectors.get(
        tenantId,
        USER_VECTOR_COLLECTION,
        userId,
      );
      if (!probe) return [];
      const matches = await this.vectors.similar(
        tenantId,
        USER_VECTOR_COLLECTION,
        probe,
        limit,
        { excludeIds: [userId] },
      );
      return matches.map((m) => ({ userId: m.id, distance: m.distance }));
    } catch (err) {
      this.logger.warn(
        'similar-lookup-failed',
        'Similar-user lookup failed',
        { 'user.id': userId },
        err,
      );
      return [];
    }
  }
}

/**
 * VECTOR_DIMENSIONS-wide embedding: 8 real signal features up front,
 * zero-padded to the stored width (a MiniLM-style 384). Cosine ordering
 * depends only on the non-zero dimensions.
 */
export function buildEmbedding(profile: UserProfileSignal): number[] {
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
  return [
    ...signal,
    ...new Array<number>(VECTOR_DIMENSIONS - signal.length).fill(0),
  ];
}
