import type { Metadata } from 'next';
import Link from 'next/link';
import { SITE_URL, CONSOLE_URL } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Self-hosted product analytics',
  description:
    'Tropis is an open, self-hostable product-analytics platform: capture events, stream-process them through a real pipeline, and watch live dashboards. Also a working reference for a modern backend.',
  alternates: { canonical: SITE_URL + '/' },
};

const FEATURES = [
  {
    title: 'Live by default',
    body: 'Events appear on your dashboard the instant they land — pushed over WebSocket, not polled.',
  },
  {
    title: 'Real analytics',
    body: 'Funnels, retention, active users, top pages — powered by a ClickHouse OLAP read model.',
  },
  {
    title: 'A real pipeline',
    body: 'Ingest → Pulsar → Flink → ClickHouse. The same event-driven backbone that scales in production.',
  },
  {
    title: 'Self-hosted & yours',
    body: 'Run it on your own infrastructure. No event data ever leaves your walls.',
  },
];

const STACK: { label: string; items: string[]; tag?: string }[] = [
  {
    label: 'Core data path',
    items: [
      'tracking (gRPC/REST)',
      'Pulsar',
      'Flink',
      'ClickHouse',
      'PostgreSQL',
      'Redis',
      'WebSocket',
    ],
  },
  {
    label: 'Feature',
    items: ['Temporal', 'Elasticsearch', 'MongoDB', 'Rust (signing)', 'Vault'],
  },
  {
    label: 'Ops / delivery',
    items: ['Grafana', 'Prometheus', 'Argo CD', 'OPA', 'Envoy'],
  },
  { label: 'Demo / reference', items: ['Aerospike', 'pgvector'], tag: 'demo' },
];

export default function HomePage() {
  return (
    <main className="wrap">
      <section className="hero">
        <p className="eyebrow">τρόπις — self-hosted product analytics</p>
        <h1>See what your users actually do — live.</h1>
        <p className="lede">
          Tropis captures events, streams them through a real pipeline, and
          shows them on live dashboards. Self-hostable and open — and built as a
          working reference for how a modern backend fits together.
        </p>
        <div className="cta">
          <a className="btn btn-primary" href={CONSOLE_URL}>
            Open the console
          </a>
          <Link className="btn" href="/pricing">
            See pricing
          </Link>
        </div>
      </section>

      <section className="section">
        <h2 className="section-title">What it does</h2>
        <div className="features">
          {FEATURES.map((f) => (
            <div className="feature" key={f.title}>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <h2 className="section-title">Built on a full modern stack</h2>
        <p className="section-lede">
          Every piece has a real job — and the layers are labeled honestly.
          Explore the live System Map in the console.
        </p>
        <div className="stack">
          {STACK.map((group) => (
            <div className="stack-row" key={group.label}>
              <span className="stack-label">{group.label}</span>
              <div className="pills">
                {group.items.map((item) => (
                  <span
                    className={group.tag === 'demo' ? 'pill pill-demo' : 'pill'}
                    key={item}
                  >
                    {item}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <footer className="foot">
        <span>Public site (harbor) · SSR + SEO</span>
        <span>The logged-in console lives in helm.</span>
      </footer>
    </main>
  );
}
