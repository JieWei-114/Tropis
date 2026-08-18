import type { Metadata } from 'next';
import Link from 'next/link';
import { SITE_URL, CONSOLE_URL } from '@/lib/site';

// Page-level SEO override (SSR-rendered into the HTML).
export const metadata: Metadata = {
  title: 'The keel every product is built on',
  description:
    'Tropis is a production-grade full-stack foundation: NestJS (gRPC), an event pipeline, Temporal workflows, and full observability — ready to build on.',
  alternates: { canonical: SITE_URL + '/' },
};

export default function HomePage() {
  return (
    <main className="wrap">
      <section className="hero">
        <p className="eyebrow">τρόπις — the keel</p>
        <h1>The foundation every product is built on.</h1>
        <p className="lede">
          Tropis is a production-grade full-stack starter — gRPC APIs, an event
          pipeline, durable workflows, and full observability, wired together and
          ready to build on.
        </p>
        <div className="cta">
          <Link className="btn btn-primary" href="/pricing">
            See pricing
          </Link>
          {/* External link to the helm console (per-env) — plain anchor is correct. */}
          <a className="btn" href={CONSOLE_URL}>
            Open the console
          </a>
        </div>
      </section>
      <footer className="foot">
        <span>Public site (harbor) · SSR + SEO</span>
        <span>The logged-in console lives in helm.</span>
      </footer>
    </main>
  );
}
