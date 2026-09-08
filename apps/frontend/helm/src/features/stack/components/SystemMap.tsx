/**
 * STACK FEATURE — every tech grouped by what it IS (database, streaming,
 * observability, …), with its live status and a link to its console.
 */
import { useTranslation } from 'react-i18next';
import type { ServiceState } from '../hooks/useStackHealth';

type Category =
  | 'services'
  | 'data'
  | 'streaming'
  | 'observability'
  | 'security'
  | 'delivery';

// Labels are translated (`stack.categories.*`); the tech names and `kind`
// strings below stay as-is because they are proper nouns.
const CATEGORIES: { key: Category; accent: string }[] = [
  { key: 'services', accent: 'text-primary-soft' },
  { key: 'data', accent: 'text-cat-purchase' },
  { key: 'streaming', accent: 'text-warning' },
  { key: 'observability', accent: 'text-success' },
  { key: 'security', accent: 'text-danger' },
  { key: 'delivery', accent: 'text-soft' },
];

interface Tech {
  name: string;
  category: Category;
  kind: string; // what the tech IS
  health?: string; // key in useStackHealth → live up/down
  url?: string; // console/UI
}

const TECHS: Tech[] = [
  {
    name: 'Backend',
    category: 'services',
    kind: 'NestJS · gRPC + REST',
    url: 'http://localhost:3100/api/docs',
    health: 'backend',
  },
  { name: 'Signing', category: 'services', kind: 'Rust gRPC service (:50052)' },
  {
    name: 'PostgreSQL',
    category: 'data',
    kind: 'relational database',
    health: 'postgres',
    url: 'http://localhost:5050',
  },
  {
    name: 'MongoDB',
    category: 'data',
    kind: 'document database',
    health: 'mongo',
    url: 'http://localhost:8085',
  },
  {
    name: 'ClickHouse',
    category: 'data',
    kind: 'columnar OLAP database',
    health: 'clickhouse',
    url: 'http://localhost:8124',
  },
  {
    name: 'Redis',
    category: 'data',
    kind: 'in-memory key-value store',
    health: 'redis',
    url: 'http://localhost:5540',
  },
  {
    name: 'Aerospike',
    category: 'data',
    kind: 'key-value store',
    health: 'aerospike',
  },
  {
    name: 'Elasticsearch',
    category: 'data',
    kind: 'search engine',
    health: 'elasticsearch',
    url: 'http://localhost:5601',
  },
  {
    name: 'pgvector',
    category: 'data',
    kind: 'vector search (Postgres extension)',
    health: 'pgvector',
  },
  {
    name: 'MinIO',
    category: 'data',
    kind: 'S3 object storage',
    health: 'minio',
    url: 'http://localhost:9902',
  },
  {
    name: 'Pulsar',
    category: 'streaming',
    kind: 'message broker',
    health: 'pulsar',
    url: 'http://localhost:9527',
  },
  {
    name: 'Flink',
    category: 'streaming',
    kind: 'stream processing',
    url: 'http://localhost:8081',
  },
  {
    name: 'Temporal',
    category: 'streaming',
    kind: 'workflow engine',
    health: 'temporal',
    url: 'http://localhost:8233',
  },
  {
    name: 'Prometheus',
    category: 'observability',
    kind: 'metrics database',
    url: 'http://localhost:9090',
  },
  {
    name: 'Grafana',
    category: 'observability',
    kind: 'metrics dashboards',
    url: 'http://localhost:3101',
  },
  {
    name: 'Jaeger',
    category: 'observability',
    kind: 'distributed tracing',
    url: 'http://localhost:16686',
  },
  {
    name: 'OpenTelemetry Collector',
    category: 'observability',
    kind: 'telemetry pipeline',
  },
  {
    name: 'Alertmanager',
    category: 'observability',
    kind: 'alerting',
    url: 'http://localhost:9093',
  },
  {
    name: 'Metabase',
    category: 'observability',
    kind: 'BI dashboards',
    url: 'http://localhost:3200',
  },
  {
    name: 'Vault',
    category: 'security',
    kind: 'secrets manager',
    url: 'http://localhost:8200',
  },
  { name: 'OPA', category: 'security', kind: 'policy engine', health: 'opa' },
  {
    name: 'Envoy',
    category: 'security',
    kind: 'service proxy',
    url: 'http://localhost:9901',
  },
  { name: 'Argo CD', category: 'delivery', kind: 'GitOps continuous delivery' },
  {
    name: 'MailHog',
    category: 'delivery',
    kind: 'email testing',
    url: 'http://localhost:8025',
  },
  {
    name: 'grpcui',
    category: 'delivery',
    kind: 'gRPC test console',
    url: 'http://localhost:8083',
  },
  {
    name: 'Dozzle',
    category: 'delivery',
    kind: 'container logs',
    url: 'http://localhost:9999',
  },
];

function statusOf(
  t: Tech,
  services: ServiceState[],
): ServiceState['status'] | null {
  if (!t.health) return null;
  return services.find((s) => s.name === t.health)?.status ?? 'down';
}

function Row({
  tech,
  services,
  note,
}: {
  tech: Tech;
  services: ServiceState[];
  note?: string;
}) {
  const { t } = useTranslation();
  const status = statusOf(tech, services);
  // 'unreachable' = we could not reach the backend, so the real state is
  // unknown — shown as a warning, never as a confirmed failure.
  const dot =
    status === 'up'
      ? 'bg-success'
      : status === 'down'
        ? 'bg-danger'
        : status === 'unreachable'
          ? 'bg-warning'
          : status === 'loading'
            ? 'bg-faint animate-pulse'
            : 'bg-transparent border border-border';
  return (
    <div className="grid grid-cols-[1fr_88px_240px] items-center gap-4 px-5 py-3.5 max-md:grid-cols-1 max-md:gap-1">
      <div className="min-w-0">
        <span className="text-sm font-semibold text-heading">{tech.name}</span>
        <span className="ml-2 text-[11px] text-muted">{tech.kind}</span>
        {note && (
          <span className="ml-2 rounded-full bg-surface px-2 py-0.5 text-[10.5px] font-medium text-soft">
            {note}
          </span>
        )}
      </div>
      <span className="inline-flex items-center gap-1.5 text-xs text-muted">
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
        {status ?? t('stack.statusUnknown')}
      </span>
      {tech.url ? (
        <a
          href={tech.url}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate font-mono text-xs text-primary-soft hover:underline"
        >
          {tech.url.replace(/^https?:\/\//, '')} ↗
        </a>
      ) : (
        <span className="text-xs text-faint">—</span>
      )}
    </div>
  );
}

export function SystemMap({
  services,
  notes,
}: {
  services: ServiceState[];
  notes?: Record<string, string>;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-8">
      {CATEGORIES.map(({ key, accent }) => {
        const rows = TECHS.filter((t) => t.category === key);
        return (
          <section key={key} className="flex flex-col gap-2.5">
            <div className="flex items-baseline gap-2">
              <h3 className={`text-sm font-semibold ${accent}`}>
                {t(`stack.categories.${key}`)}
              </h3>
              <span className="text-[11px] text-faint">{rows.length}</span>
            </div>
            <div className="divide-y divide-border-soft overflow-hidden rounded-xl border border-border bg-card">
              {rows.map((t) => (
                <Row
                  key={t.name}
                  tech={t}
                  services={services}
                  note={notes?.[t.name]}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
