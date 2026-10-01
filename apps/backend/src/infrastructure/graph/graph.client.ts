import type { TenantId } from '../../common/keyspace';
import type { CapabilityHealth } from '../capability';
import type {
  GraphAccessMode,
  GraphEngine,
  GraphParams,
  GraphPort,
  GraphProperties,
  GraphRecord,
} from './graph.port';
import {
  assertLabel,
  assertNodeId,
  assertProperties,
  assertRelationshipType,
  assertResultTenant,
  assertTenant,
  assertTenantScopedQuery,
  bindTenant,
} from './graph.tenancy';

/** GraphPort over any GraphEngine; the single place tenancy is enforced. */
export class GraphClient implements GraphPort {
  constructor(private readonly engine: GraphEngine) {}

  read<T extends GraphRecord = GraphRecord>(
    tenantId: TenantId,
    cypher: string,
    params?: GraphParams,
  ): Promise<T[]> {
    return this.run<T>('read', tenantId, cypher, params);
  }

  write<T extends GraphRecord = GraphRecord>(
    tenantId: TenantId,
    cypher: string,
    params?: GraphParams,
  ): Promise<T[]> {
    return this.run<T>('write', tenantId, cypher, params);
  }

  async mergeNode(
    tenantId: TenantId,
    label: string,
    id: string,
    props: GraphProperties = {},
  ): Promise<void> {
    assertLabel(label);
    assertNodeId(id);
    assertProperties(props);
    await this.write(
      tenantId,
      `MERGE (n:\`${label}\` {tenantId: $tenantId, id: $id}) SET n += $props`,
      { id, props },
    );
  }

  async mergeEdge(
    tenantId: TenantId,
    fromLabel: string,
    fromId: string,
    type: string,
    toLabel: string,
    toId: string,
    props: GraphProperties = {},
  ): Promise<boolean> {
    assertLabel(fromLabel);
    assertLabel(toLabel);
    assertRelationshipType(type);
    assertNodeId(fromId);
    assertNodeId(toId);
    assertProperties(props);
    const rows = await this.write<{ merged: number }>(
      tenantId,
      `MATCH (a:\`${fromLabel}\` {tenantId: $tenantId, id: $fromId})
       MATCH (b:\`${toLabel}\` {tenantId: $tenantId, id: $toId})
       MERGE (a)-[r:\`${type}\` {tenantId: $tenantId}]->(b)
       SET r += $props
       RETURN count(r) AS merged`,
      { fromId, toId, props },
    );
    return Number(rows[0]?.merged ?? 0) > 0;
  }

  health(): Promise<CapabilityHealth> {
    return this.engine.health();
  }

  /** Closes the engine's connections on shutdown. */
  async onApplicationShutdown(): Promise<void> {
    await this.engine.close();
  }

  private async run<T extends GraphRecord>(
    mode: GraphAccessMode,
    tenantId: TenantId,
    cypher: string,
    params?: GraphParams,
  ): Promise<T[]> {
    assertTenant(tenantId);
    assertTenantScopedQuery(cypher);
    const records = await this.engine.run(
      mode,
      cypher,
      bindTenant(tenantId, params),
    );
    assertResultTenant(tenantId, records);
    return records as T[];
  }
}
