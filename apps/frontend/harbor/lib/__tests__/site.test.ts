import { describe, expect, it } from 'vitest';
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
});
