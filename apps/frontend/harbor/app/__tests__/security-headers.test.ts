import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config.mjs';

async function headersFor(source: string) {
  const rules = (await nextConfig.headers?.()) ?? [];
  const rule = rules.find((r) => r.source === source);
  return Object.fromEntries(
    (rule?.headers ?? []).map((h) => [h.key.toLowerCase(), h.value]),
  );
}

describe('harbor security headers', () => {
  it('sends the hardening headers on every route', async () => {
    const h = await headersFor('/:path*');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(h['permissions-policy']).toContain('camera=()');
    expect(h['strict-transport-security']).toMatch(/max-age=\d+/);
  });

  it('sends a CSP that blocks framing, plugins and foreign connections', async () => {
    const csp = (await headersFor('/:path*'))['content-security-policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("'unsafe-eval'");
  });
});
