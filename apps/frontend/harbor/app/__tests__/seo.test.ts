import { describe, expect, it } from 'vitest';
import { SITE_URL } from '@/lib/site';
import robots from '../robots';
import sitemap from '../sitemap';

describe('robots.txt', () => {
  const result = robots();

  it('lets crawlers index the whole site', () => {
    expect(result.rules).toEqual({ userAgent: '*', allow: '/' });
  });

  it('points at an absolute sitemap URL on this site', () => {
    const sitemapUrl = String(result.sitemap);
    expect(() => new URL(sitemapUrl)).not.toThrow();
    expect(sitemapUrl).toBe(`${SITE_URL}/sitemap.xml`);
    expect(new URL(sitemapUrl).pathname).toBe('/sitemap.xml');
  });
});

describe('sitemap.xml', () => {
  const entries = sitemap();

  it('is not empty', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it('lists absolute, same-origin, non-duplicated URLs', () => {
    const urls = entries.map((entry) => entry.url);

    for (const url of urls) {
      expect(() => new URL(url)).not.toThrow();
      expect(new URL(url).origin).toBe(new URL(SITE_URL).origin);
      // No accidental double slashes from concatenating SITE_URL.
      expect(new URL(url).pathname).not.toMatch(/\/\//);
    }

    expect(new Set(urls).size).toBe(urls.length);
  });

  it('uses valid priorities and change frequencies', () => {
    const allowed = [
      'always',
      'hourly',
      'daily',
      'weekly',
      'monthly',
      'yearly',
      'never',
    ];

    for (const entry of entries) {
      expect(entry.priority).toBeGreaterThan(0);
      expect(entry.priority).toBeLessThanOrEqual(1);
      expect(allowed).toContain(entry.changeFrequency);
    }
  });

  it('includes the home page at top priority', () => {
    const home = entries.find((entry) => new URL(entry.url).pathname === '/');
    expect(home).toBeDefined();
    expect(home?.priority).toBe(1);
  });

  it('covers every public page route', () => {
    const paths = entries.map((entry) => new URL(entry.url).pathname).sort();
    expect(paths).toEqual(['/', '/pricing']);
  });
});
