import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The console's Content-Security-Policy lives in nginx.conf and is rendered
 * per build by scripts/render-nginx-conf.mjs. These tests pin the two ways it
 * can silently break the page: a stale inline-script hash, and a connect-src
 * that does not name the endpoints the bundle calls.
 */

const ROOT = join(__dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'render-nginx-conf.mjs');
const CONF = join(ROOT, 'nginx.conf');
const HTML = join(ROOT, 'index.html');

const read = (p: string) => readFileSync(p, 'utf8');

function render(env: Record<string, string>, html = HTML): string {
  return execFileSync(process.execPath, [SCRIPT, CONF, html], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
  });
}

function csp(conf: string): string[] {
  return [
    ...conf.matchAll(/add_header Content-Security-Policy "([^"]+)"/g),
  ].map((m) => m[1]);
}

describe('helm Content-Security-Policy', () => {
  it('allows the inline theme script of index.html by its hash', () => {
    const scripts = [...read(HTML).matchAll(/<script>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    const hash = createHash('sha256').update(scripts[0][1]).digest('base64');
    const policies = csp(read(CONF));
    expect(policies.length).toBeGreaterThanOrEqual(2);
    for (const policy of policies) {
      expect(policy).toContain(`'sha256-${hash}'`);
      expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
      expect(policy).toContain("frame-ancestors 'none'");
    }
  });

  it('names the API, RPC and realtime origins of the build in connect-src', () => {
    const out = render({
      VITE_API_BASE_URL: 'https://api.example.com',
      VITE_RPC_URL: 'https://rpc.example.com/',
      VITE_WS_URL: 'https://api.example.com',
    });
    expect(out).not.toContain('__CSP_CONNECT_SRC__');
    for (const policy of csp(out)) {
      expect(policy).toContain(
        "connect-src 'self' https://api.example.com https://rpc.example.com wss://api.example.com;",
      );
    }
  });

  it('falls back to the local-dev endpoints of src/lib/env.ts', () => {
    const envTs = read(join(ROOT, 'src', 'lib', 'env.ts'));
    const def = (key: string) =>
      new URL(new RegExp(`${key}: '([^']+)'`).exec(envTs)![1]);
    const api = def('VITE_API_BASE_URL');
    const rpc = def('VITE_RPC_URL');
    const ws = def('VITE_WS_URL');
    const out = render({});
    for (const policy of csp(out)) {
      expect(policy).toContain(
        `connect-src 'self' ${api.origin} ${rpc.origin} ws://${ws.host};`,
      );
    }
  });

  it('fails the render when the inline script changed without the hash', () => {
    const tmp = join(ROOT, 'node_modules', '.tmp-csp-index.html');
    const html = read(HTML).replace('<script>', '<script>/* edited */');
    writeFileSync(tmp, html);
    try {
      expect(() => render({}, tmp)).toThrow();
    } finally {
      rmSync(tmp, { force: true });
    }
  });
});
