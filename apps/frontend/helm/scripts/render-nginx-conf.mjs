#!/usr/bin/env node
/**
 * Renders nginx.conf for one build of helm:
 *
 *   node scripts/render-nginx-conf.mjs <nginx.conf> <dist/index.html> > out.conf
 *
 * - Replaces __CSP_CONNECT_SRC__ in the Content-Security-Policy with the
 *   origins this build calls (VITE_API_BASE_URL, VITE_RPC_URL, VITE_WS_URL
 *   plus its ws:/wss: form), the same variables Vite inlines into the bundle.
 * - Fails when an inline script of the built index.html has no matching
 *   'sha256-...' source in the policy, so editing the theme bootstrap
 *   without updating the hash breaks the build instead of the page.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const PLACEHOLDER = '__CSP_CONNECT_SRC__';

/** CSP source of every inline (src-less) script in an HTML document. */
export function inlineScriptHashes(html) {
  const hashes = [];
  for (const match of html.matchAll(
    /<script(\s[^>]*)?>([\s\S]*?)<\/script>/g,
  )) {
    const attrs = match[1] ?? '';
    if (/\ssrc\s*=/.test(attrs)) continue;
    const digest = createHash('sha256')
      .update(match[2], 'utf8')
      .digest('base64');
    hashes.push(`'sha256-${digest}'`);
  }
  return hashes;
}

/**
 * The endpoints src/lib/env.ts falls back to when a VITE_* variable is unset,
 * so a build without build args gets a policy matching its bundle.
 */
export const DEFAULT_ENDPOINTS = {
  VITE_API_BASE_URL: 'http://localhost:3100',
  VITE_RPC_URL: 'http://localhost:50051',
  VITE_WS_URL: 'http://localhost:3100',
};

/** Origins (and the websocket form of the realtime one) a build connects to. */
export function connectSources(env) {
  const sources = new Set();
  const pick = (key) =>
    env[key] && env[key].trim() ? env[key] : DEFAULT_ENDPOINTS[key];
  const add = (raw, websocket = false) => {
    let url;
    try {
      url = new URL(raw.trim());
    } catch {
      throw new Error(`not an absolute URL: ${raw}`);
    }
    sources.add(url.origin);
    if (websocket) {
      const ws = url.protocol === 'https:' ? 'wss:' : 'ws:';
      sources.add(`${ws}//${url.host}`);
    }
  };
  add(pick('VITE_API_BASE_URL'));
  add(pick('VITE_RPC_URL'));
  add(pick('VITE_WS_URL'), true);
  return [...sources];
}

export function renderNginxConf(conf, html, env) {
  if (!conf.includes(PLACEHOLDER)) {
    throw new Error(`nginx.conf has no ${PLACEHOLDER} placeholder`);
  }
  const missing = inlineScriptHashes(html).filter((h) => !conf.includes(h));
  if (missing.length > 0) {
    throw new Error(
      `inline script hash missing from the CSP in nginx.conf: ${missing.join(' ')}`,
    );
  }
  return conf.replaceAll(PLACEHOLDER, connectSources(env).join(' '));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [confPath, htmlPath] = process.argv.slice(2);
  if (!confPath || !htmlPath) {
    process.stderr.write(
      'usage: render-nginx-conf.mjs <nginx.conf> <index.html>\n',
    );
    process.exit(2);
  }
  try {
    process.stdout.write(
      renderNginxConf(
        readFileSync(confPath, 'utf8'),
        readFileSync(htmlPath, 'utf8'),
        process.env,
      ),
    );
  } catch (err) {
    process.stderr.write(`render-nginx-conf: ${err.message}\n`);
    process.exit(1);
  }
}
