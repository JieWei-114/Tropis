import type { Metadata } from 'next';
import Link from 'next/link';
import { SITE_URL } from '@/lib/site';

// Second public page — demonstrates per-route SEO. Add real public pages the
// same way: a folder under app/ with its own `metadata`.
export const metadata: Metadata = {
  title: 'Pricing',
  description: 'Simple, transparent pricing for teams of every size.',
  alternates: { canonical: SITE_URL + '/pricing' },
};

export default function PricingPage() {
  return (
    <main className="wrap">
      <section className="hero">
        <p className="eyebrow">Pricing</p>
        <h1>Simple, transparent pricing.</h1>
        <p className="lede">Replace with your real plans. This page is SSR-rendered and fully crawlable.</p>
        <Link className="btn btn-primary" href="/">
          ← Back home
        </Link>
      </section>
    </main>
  );
}
