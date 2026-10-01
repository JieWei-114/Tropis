import { isTenantId, type TenantId } from '../../common/keyspace';

export class GraphTenancyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphTenancyError';
  }
}

/** Parameter the port binds on every query. */
export const TENANT_PARAM = 'tenantId';
/** Properties owned by the port on every node/relationship it writes. */
const RESERVED_PROPERTIES = new Set(['tenantId', 'id']);

const LABEL_PATTERN = /^[A-Z][A-Za-z0-9]*$/;
const RELATIONSHIP_TYPE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** Removes comments and string literals so a reference inside them does not count. */
function stripNonCode(cypher: string): string {
  return cypher
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:``|[^`])*`/g, '``');
}

export function assertTenantScopedQuery(cypher: string): void {
  if (
    typeof cypher !== 'string' ||
    !/\$tenantId\b/.test(stripNonCode(cypher))
  ) {
    throw new GraphTenancyError(
      'Graph query must reference $tenantId (outside comments and strings)',
    );
  }
}

export function assertTenant(tenantId: TenantId): void {
  if (!isTenantId(tenantId)) {
    throw new GraphTenancyError(
      `Invalid tenant id ${JSON.stringify(tenantId)}`,
    );
  }
}

export function bindTenant(
  tenantId: TenantId,
  params: Record<string, unknown> = {},
): Record<string, unknown> {
  if (Object.prototype.hasOwnProperty.call(params, TENANT_PARAM)) {
    throw new GraphTenancyError(
      '$tenantId is bound by the port; do not pass it in params',
    );
  }
  return { ...params, [TENANT_PARAM]: tenantId };
}

export function assertProperties(props: Record<string, unknown>): void {
  for (const key of Object.keys(props)) {
    if (RESERVED_PROPERTIES.has(key)) {
      throw new GraphTenancyError(
        `Property '${key}' is owned by the graph port and cannot be set`,
      );
    }
  }
}

export function assertLabel(label: string): void {
  if (!LABEL_PATTERN.test(label)) {
    throw new GraphTenancyError(
      `Invalid node label ${JSON.stringify(label)}: expected PascalCase`,
    );
  }
}

export function assertRelationshipType(type: string): void {
  if (!RELATIONSHIP_TYPE_PATTERN.test(type)) {
    throw new GraphTenancyError(
      `Invalid relationship type ${JSON.stringify(type)}: expected UPPER_SNAKE_CASE`,
    );
  }
}

export function assertNodeId(id: string): void {
  if (typeof id !== 'string' || id.length === 0) {
    throw new GraphTenancyError('Node id must be a non-empty string');
  }
}

function isEntity(
  value: unknown,
): value is { properties: Record<string, unknown> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { properties?: unknown }).properties === 'object' &&
    ('labels' in value || 'type' in value)
  );
}

/**
 * Throws when a result carries a node or relationship of another tenant, so
 * a query whose patterns forgot `{tenantId: $tenantId}` cannot return
 * another tenant's entities (scalar projections are covered by review).
 */
export function assertResultTenant(
  tenantId: TenantId,
  records: readonly Record<string, unknown>[],
): void {
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (isEntity(value)) {
      if (value.properties[TENANT_PARAM] !== tenantId) {
        throw new GraphTenancyError(
          'Graph query returned an entity outside the tenant',
        );
      }
      return;
    }
    if (typeof value === 'object' && value !== null) {
      Object.values(value).forEach(visit);
    }
  };
  records.forEach(visit);
}
