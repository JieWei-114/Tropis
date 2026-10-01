import type { TenantId } from '../../common/keyspace';
import type { HealthCheckable } from '../capability';

/**
 * Graph — relationship traversal over openCypher. The port accepts only
 * portable openCypher (no vendor procedures), so Neo4j, Memgraph, FalkorDB or
 * Apache AGE stay adapter swaps.
 *
 * Tenancy is enforced by the port:
 *   - every node and relationship written through mergeNode/mergeEdge
 *     carries a `tenantId` property, and node identity is (tenantId, id);
 *   - every query receives `$tenantId`, bound from the tenantId argument —
 *     callers cannot pass it in params;
 *   - a query whose text (outside comments and string literals) does not
 *     reference `$tenantId` is rejected with GraphTenancyError.
 * Convention for hand-written queries: constrain every node and relationship
 * pattern with `{tenantId: $tenantId}`, and set `tenantId: $tenantId` on
 * every CREATE/MERGE. The reference check cannot prove a query honours that,
 * so review hand-written Cypher against it.
 */
export const GRAPH = Symbol('GRAPH');

export type GraphParams = Record<string, unknown>;
export type GraphRecord = Record<string, unknown>;
export type GraphProperties = Record<
  string,
  string | number | boolean | null | string[] | number[] | boolean[]
>;

/** Driver-neutral shape of a node returned by a query. */
export interface GraphNode {
  labels: string[];
  properties: Record<string, unknown>;
}

/** Driver-neutral shape of a relationship returned by a query. */
export interface GraphRelationship {
  type: string;
  properties: Record<string, unknown>;
}

export interface GraphPort extends HealthCheckable {
  /** Runs a read-only query in a read session. */
  read<T extends GraphRecord = GraphRecord>(
    tenantId: TenantId,
    cypher: string,
    params?: GraphParams,
  ): Promise<T[]>;
  /** Runs a query in a write session. */
  write<T extends GraphRecord = GraphRecord>(
    tenantId: TenantId,
    cypher: string,
    params?: GraphParams,
  ): Promise<T[]>;
  /** Upserts node (label, tenantId, id) and merges `props` into it. */
  mergeNode(
    tenantId: TenantId,
    label: string,
    id: string,
    props?: GraphProperties,
  ): Promise<void>;
  /**
   * Upserts a relationship between two nodes of the same tenant. Resolves
   * false (and writes nothing) when either endpoint does not exist in that
   * tenant.
   */
  mergeEdge(
    tenantId: TenantId,
    fromLabel: string,
    fromId: string,
    type: string,
    toLabel: string,
    toId: string,
    props?: GraphProperties,
  ): Promise<boolean>;
}

export type GraphAccessMode = 'read' | 'write';

/**
 * Adapter-facing contract: execute Cypher in a read or write session and
 * return driver-neutral records. Tenancy checks live once in GraphClient.
 */
export interface GraphEngine extends HealthCheckable {
  run(
    mode: GraphAccessMode,
    cypher: string,
    params: GraphParams,
  ): Promise<GraphRecord[]>;
  close(): Promise<void>;
}

export const GRAPH_ADAPTERS = ['neo4j', 'disabled'] as const;
export type GraphAdapterName = (typeof GRAPH_ADAPTERS)[number];
