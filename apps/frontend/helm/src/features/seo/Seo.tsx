/**
 * <Seo> — per-page SEO metadata. Drop one into any page component and it
 * sets the document <title>, meta description, canonical URL, and the
 * Open Graph / Twitter Card tags used by Google and social-share previews.
 *
 *   <Seo
 *     title="Pricing"
 *     description="Simple, transparent pricing for teams of every size."
 *     path="/pricing"
 *   />
 *
 * Rendered via react-helmet-async, so the last <Seo> mounted wins — safe to
 * nest a page-level tag inside a layout that already sets defaults.
 *
 * NOTE: this app is a client-rendered SPA. These tags are correct for Google
 * (it executes JS) and for social scrapers *if* the target route is
 * pre-rendered/SSR'd. For public marketing pages that must rank everywhere,
 * pair this with a pre-render/SSG step (see docs) — the component stays the same.
 */

import { Helmet } from 'react-helmet-async';
import { env } from '../../lib/env';

const SITE_NAME = 'Tropis';
const DEFAULT_DESCRIPTION =
  'Tropis — the keel. The foundation every product is built on.';
/** Default social-share image; place a 1200×630 PNG at public/og-default.png. */
const DEFAULT_OG_IMAGE = '/og-default.png';

interface SeoProps {
  /** Page title; rendered as "Title · Tropis" (omit for the bare site name). */
  title?: string;
  /** Meta description — aim for 120–160 characters. */
  description?: string;
  /** Absolute-from-root path for the canonical URL, e.g. "/pricing". */
  path?: string;
  /** Absolute or root-relative image URL for OG/Twitter cards. */
  image?: string;
  /** og:type — "website" (default) or "article" for blog posts. */
  type?: 'website' | 'article';
  /** Set true on private/app routes so crawlers skip them. */
  noindex?: boolean;
}

function absolute(pathOrUrl: string): string {
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  return `${env.VITE_SITE_URL.replace(/\/$/, '')}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
}

export function Seo({
  title,
  description = DEFAULT_DESCRIPTION,
  path,
  image = DEFAULT_OG_IMAGE,
  type = 'website',
  noindex = false,
}: SeoProps) {
  const fullTitle = title ? `${title} · ${SITE_NAME}` : SITE_NAME;
  const canonical = path ? absolute(path) : undefined;
  const ogImage = absolute(image);

  return (
    <Helmet>
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      {canonical && <link rel="canonical" href={canonical} />}
      {noindex && <meta name="robots" content="noindex, nofollow" />}

      {/* Open Graph (Facebook, LinkedIn, WhatsApp, WeChat, …) */}
      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:type" content={type} />
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      {canonical && <meta property="og:url" content={canonical} />}
      <meta property="og:image" content={ogImage} />

      {/* Twitter / X card */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={ogImage} />
    </Helmet>
  );
}
