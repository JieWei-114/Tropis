import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONSOLE_URL, SITE_DESCRIPTION, SITE_NAME, SITE_URL } from '../site';

describe('lib/site', () => {
  it('exposes a non-empty name and description', () => {
    expect(SITE_NAME.trim()).not.toBe('');
    expect(SITE_DESCRIPTION.trim().length).toBeGreaterThan(20);
  });

  it.each([
    ['SITE_URL', SITE_URL],
    ['CONSOLE_URL', CONSOLE_URL],
  ])('%s is an absolute http(s) URL with no trailing slash', (_name, value) => {
    expect(() => new URL(value)).not.toThrow();
    expect(new URL(value).protocol).toMatch(/^https?:$/);
    expect(value).not.toMatch(/\/$/);
  });

  it.each([
    ['/', `${SITE_URL}/`],
    ['/pricing', `${SITE_URL}/pricing`],
    ['/sitemap.xml', `${SITE_URL}/sitemap.xml`],
  ])('builds %s into a single-slash absolute URL', (pathname, built) => {
    expect(new URL(built).pathname).toBe(pathname);
    expect(built.replace(/^https?:\/\//, '')).not.toMatch(/\/\//);
  });

  it('separates the public site from the console', () => {
    expect(SITE_URL).not.toBe(CONSOLE_URL);
  });

  describe('environment fallbacks', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    // An unset CI repository variable reaches the build as an empty string,
    // which must fall back to the default rather than produce a relative URL.
    it.each(['NEXT_PUBLIC_SITE_URL', 'NEXT_PUBLIC_CONSOLE_URL'])(
      'treats an empty %s as unset',
      async (name) => {
        vi.stubEnv(name, '');
        vi.resetModules();
        const site = await import('../site');
        const value =
          name === 'NEXT_PUBLIC_SITE_URL' ? site.SITE_URL : site.CONSOLE_URL;
        expect(() => new URL(value)).not.toThrow();
      },
    );

    it('strips a trailing slash from a configured URL', async () => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://example.com/');
      vi.resetModules();
      const site = await import('../site');
      expect(site.SITE_URL).toBe('https://example.com');
    });
  });
});
