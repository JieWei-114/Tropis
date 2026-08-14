import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

// Native Next sitemap — served at /sitemap.xml. List every public URL here as
// you add pages (or generate from a route table / CMS).
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE_URL}/`, changeFrequency: 'weekly', priority: 1 },
    { url: `${SITE_URL}/pricing`, changeFrequency: 'monthly', priority: 0.8 },
  ];
}
