import neo4j, {
  type Driver,
  isDate,
  isDateTime,
  isDuration,
  isInt,
  isLocalDateTime,
  isLocalTime,
  isNode,
  isPath,
  isPoint,
  isRelationship,
  isTime,
} from 'neo4j-driver';
import { probeCapability, type CapabilityHealth } from '../../../capability';
import type {
  GraphAccessMode,
  GraphEngine,
  GraphNode,
  GraphParams,
  GraphRecord,
  GraphRelationship,
} from '../../graph.port';

export interface Neo4jGraphOptions {
  uri: string;
  user: string;
  password: string;
}

/** GraphEngine over the Neo4j Bolt driver; results are converted to plain values. */
export class Neo4jGraphEngine implements GraphEngine {
  private readonly driver: Driver;

  constructor(options: Neo4jGraphOptions) {
    this.driver = neo4j.driver(
      options.uri,
      neo4j.auth.basic(options.user, options.password),
      // Plain JS numbers instead of the driver's Integer type, so no driver
      // type leaks past this adapter.
      { disableLosslessIntegers: true },
    );
  }

  async run(
    mode: GraphAccessMode,
    cypher: string,
    params: GraphParams,
  ): Promise<GraphRecord[]> {
    const session = this.driver.session({
      defaultAccessMode:
        mode === 'read' ? neo4j.session.READ : neo4j.session.WRITE,
    });
    try {
      const work = async (tx: {
        run: (
          q: string,
          p: GraphParams,
        ) => PromiseLike<{
          records: { toObject(): Record<string, unknown> }[];
        }>;
      }) => (await tx.run(cypher, params)).records;
      const records =
        mode === 'read'
          ? await session.executeRead(work)
          : await session.executeWrite(work);
      return records.map((record) => toPlain(record.toObject()) as GraphRecord);
    } finally {
      await session.close();
    }
  }

  health(): Promise<CapabilityHealth> {
    return probeCapability('neo4j', () => this.driver.getServerInfo());
  }

  close(): Promise<void> {
    return this.driver.close();
  }
}

function toPlain(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(toPlain);
  if (isInt(value)) return value.toNumber();
  if (isNode(value)) {
    return {
      labels: [...value.labels],
      properties: toPlain(value.properties),
    } as GraphNode;
  }
  if (isRelationship(value)) {
    return {
      type: value.type,
      properties: toPlain(value.properties),
    } as GraphRelationship;
  }
  if (isPath(value)) {
    return value.segments.map((segment) => ({
      start: toPlain(segment.start),
      relationship: toPlain(segment.relationship),
      end: toPlain(segment.end),
    }));
  }
  if (
    isDate(value) ||
    isDateTime(value) ||
    isLocalDateTime(value) ||
    isTime(value) ||
    isLocalTime(value) ||
    isDuration(value) ||
    isPoint(value)
  ) {
    return value.toString();
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      toPlain(v),
    ]),
  );
}
