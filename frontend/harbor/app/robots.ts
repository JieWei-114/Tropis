import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

// Native Next robots.txt — served at /robots.txt, generated from code.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/' },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
