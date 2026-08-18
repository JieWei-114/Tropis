/**
 * STACK FEATURE — categorized links to every dev-stack UI.
 */
const LINKS = [
  {
    category: 'Backend',
    items: [
      {
        label: 'Swagger UI',
        url: 'http://localhost:3100/api/docs',
        desc: 'REST endpoint docs (health + metrics)',
      },
      {
        label: 'Prometheus',
        url: 'http://localhost:9090',
        desc: 'Metrics query UI — try http_requests_total',
      },
      {
        label: 'Grafana',
        url: 'http://localhost:3101',
        desc: 'Dashboards — admin / admin',
      },
      {
        label: 'Vault UI',
        url: 'http://localhost:8200',
        desc: 'Secret management (backend only) — token: dev-root-token',
      },
    ],
  },
  {
    category: 'Tracing',
    items: [
      {
        label: 'Jaeger',
        url: 'http://localhost:16686',
        desc: 'Distributed traces — search by service nestjs-app',
      },
    ],
  },
  {
    category: 'Messaging',
    items: [
      {
        label: 'Pulsar Manager',
        url: 'http://localhost:9527',
        desc: 'Pulsar web UI — topics, subscriptions, producers, consumers',
      },
      {
        label: 'Pulsar Admin',
        url: 'http://localhost:8080/admin/v2/persistent/public/default',
        desc: 'Raw admin API — topic list',
      },
      {
        label: 'Flink UI',
        url: 'http://localhost:8081',
        desc: 'Stream job manager — Pulsar → ClickHouse',
      },
    ],
  },
  {
    category: 'Storage',
    items: [
      {
        label: 'MinIO Console',
        url: 'http://localhost:9902',
        desc: 'Object storage — minioadmin / minioadmin123',
      },
    ],
  },
  {
    category: 'Cache & Queues',
    items: [
      {
        label: 'RedisInsight',
        url: 'http://localhost:5540',
        desc: 'Redis browser — keys, memory, pub/sub, slow log',
      },
      {
        label: 'Bull Board',
        url: 'http://localhost:3100/api/queues',
        desc: 'BullMQ queue dashboard — jobs, retries, failed, completed',
      },
    ],
  },
  {
    category: 'Databases',
    items: [
      {
        label: 'Mongo Express',
        url: 'http://localhost:8085',
        desc: 'MongoDB browser — collections, documents, indexes',
      },
      {
        label: 'pgAdmin',
        url: 'http://localhost:5050',
        desc: 'PostgreSQL admin — admin@local.dev / admin',
      },
      {
        label: 'Kibana',
        url: 'http://localhost:5601',
        desc: 'Elasticsearch UI — index management, Dev Tools',
      },
      {
        label: 'CH-UI',
        url: 'http://localhost:8124',
        desc: 'ClickHouse query UI — connect to http://localhost:8123',
      },
    ],
  },
  {
    category: 'Email',
    items: [
      {
        label: 'MailHog',
        url: 'http://localhost:8025',
        desc: 'Dev email trap — all emails caught here',
      },
    ],
  },
  {
    category: 'Proxy',
    items: [
      {
        label: 'Envoy Admin',
        url: 'http://localhost:9901',
        desc: 'gRPC-Web proxy stats',
      },
    ],
  },
];

export function StackLinks() {
  return (
    <>
      {LINKS.map((cat) => (
        <div key={cat.category} className="flex flex-col gap-2.5">
          <h3 className="text-xs font-semibold tracking-[0.6px] text-muted uppercase">
            {cat.category}
          </h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2.5 max-md:grid-cols-1">
            {cat.items.map((item) => (
              <a
                key={item.label}
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex flex-col gap-1 rounded-[10px] border border-border bg-card px-4 py-3.5 no-underline transition-colors hover:border-primary/40 hover:bg-raised"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-foreground">
                    {item.label}
                  </span>
                  <span className="text-sm text-primary">↗</span>
                </div>
                <span className="font-mono text-[11px] text-primary">
                  {item.url}
                </span>
                <span className="mt-0.5 text-xs text-muted">{item.desc}</span>
              </a>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
