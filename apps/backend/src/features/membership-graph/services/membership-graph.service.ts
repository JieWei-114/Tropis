import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import type { TenantId } from '../../../common/keyspace';
import {
  GRAPH,
  type GraphPort,
} from '../../../infrastructure/graph/graph.port';
import {
  INVITED,
  MAX_INVITATION_HOPS,
  MAX_MEMBERS_PAGE,
  MEMBER_OF,
  TENANT_LABEL,
  USER_LABEL,
} from '../constants/membership-graph.constants';

/** A user's membership as carried by identity.user.created / identity.user.updated. */
export interface MembershipFacts {
  userId: string;
  /** User who invited this one, when the event names one. */
  invitedBy?: string;
}

/**
 * Projection of tenant membership into the graph capability:
 *   (User)-[:MEMBER_OF]->(Tenant)   one per member
 *   (User)-[:INVITED]->(User)       inviter to invitee
 * Nodes carry ids only, no profile data. Every write is a MERGE, so a
 * replayed event changes nothing. A removed user loses MEMBER_OF but keeps
 * its node and INVITED edges, so chains through it stay intact. Removal is
 * terminal (a deleted user never comes back under its id), so an event that
 * arrives after it, such as a redelivered identity.user.updated, changes nothing.
 */
@Injectable()
export class MembershipGraphService {
  constructor(@Inject(GRAPH) private readonly graph: GraphPort) {}

  async isEnabled(): Promise<boolean> {
    return (await this.graph.health()).status !== 'disabled';
  }

  /** False when the user was already removed; nothing is written then. */
  async recordMember(
    tenantId: TenantId,
    facts: MembershipFacts,
  ): Promise<boolean> {
    const [existing] = await this.graph.read<{ removed: unknown }>(
      tenantId,
      `MATCH (u:User {tenantId: $tenantId, id: $userId})
       RETURN u.removed AS removed`,
      { userId: facts.userId },
    );
    if (existing?.removed === true) return false;
    await this.graph.mergeNode(tenantId, TENANT_LABEL, tenantId);
    await this.graph.mergeNode(tenantId, USER_LABEL, facts.userId, {
      removed: false,
    });
    await this.graph.mergeEdge(
      tenantId,
      USER_LABEL,
      facts.userId,
      MEMBER_OF,
      TENANT_LABEL,
      tenantId,
    );
    if (facts.invitedBy && facts.invitedBy !== facts.userId) {
      await this.graph.mergeNode(tenantId, USER_LABEL, facts.invitedBy);
      await this.graph.mergeEdge(
        tenantId,
        USER_LABEL,
        facts.invitedBy,
        INVITED,
        USER_LABEL,
        facts.userId,
      );
    }
    return true;
  }

  /**
   * Leaves a tombstone even for a user never recorded, so an identity.user.created
   * that arrives after the identity.user.deleted cannot record a deleted member.
   */
  async removeMember(tenantId: TenantId, userId: string): Promise<void> {
    await this.graph.write(
      tenantId,
      `MERGE (u:User {tenantId: $tenantId, id: $userId})
       SET u.removed = true
       WITH u
       OPTIONAL MATCH (u)-[m:MEMBER_OF {tenantId: $tenantId}]->(:Tenant {tenantId: $tenantId})
       DELETE m`,
      { userId },
    );
  }

  /** Member user ids of the tenant, ordered by id. */
  async membersOf(
    tenantId: TenantId,
    page: { limit?: number; offset?: number } = {},
  ): Promise<string[]> {
    const limit = boundedInt(page.limit ?? 100, 1, MAX_MEMBERS_PAGE, 'limit');
    const offset = boundedInt(
      page.offset ?? 0,
      0,
      Number.MAX_SAFE_INTEGER,
      'offset',
    );
    const rows = await this.graph.read<{ userId: string }>(
      tenantId,
      `MATCH (u:User {tenantId: $tenantId})-[:MEMBER_OF {tenantId: $tenantId}]->(:Tenant {tenantId: $tenantId, id: $tenantId})
       RETURN u.id AS userId
       ORDER BY userId
       SKIP toInteger($offset) LIMIT toInteger($limit)`,
      { limit, offset },
    );
    return rows.map((r) => r.userId);
  }

  /**
   * Who invited `userId`, then who invited them, up to `maxHops` steps;
   * nearest inviter first. Empty when the user has no recorded inviter.
   */
  async invitationChain(
    tenantId: TenantId,
    userId: string,
    maxHops = MAX_INVITATION_HOPS,
  ): Promise<string[]> {
    const hops = boundedInt(maxHops, 1, MAX_INVITATION_HOPS, 'maxHops');
    const rows = await this.graph.read<{ chain: string[] }>(
      tenantId,
      `MATCH p = (:User {tenantId: $tenantId})-[:INVITED*1..${hops}]->(:User {tenantId: $tenantId, id: $userId})
       WHERE all(r IN relationships(p) WHERE r.tenantId = $tenantId)
         AND all(n IN nodes(p) WHERE n.tenantId = $tenantId)
       RETURN [n IN reverse(nodes(p))[1..] | n.id] AS chain
       ORDER BY length(p) DESC
       LIMIT 1`,
      { userId },
    );
    return rows[0]?.chain ?? [];
  }
}

function boundedInt(
  value: number,
  min: number,
  max: number,
  field: string,
): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw AppError.validation([
      { field, description: `must be an integer between ${min} and ${max}` },
    ]);
  }
  return value;
}
