#!/usr/bin/env node
/**
 * Writes src-tauri/gen/csp.conf.json, a `tauri build --config` overlay whose
 * CSP connect-src names the endpoints this build of helm calls (the same
 * VITE_* values Vite reads: helm's .env files, then the environment).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectSources } from '../../frontend/helm/scripts/render-nginx-conf.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HELM = join(HERE, '..', '..', 'frontend', 'helm');
const CONF = join(HERE, '..', 'src-tauri', 'tauri.conf.json');
const OUT = join(HERE, '..', 'src-tauri', 'gen', 'csp.conf.json');
const ENV_FILES = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.production.local',
];
const IPC = ['ipc:', 'http://ipc.localhost'];

export function parseDotenv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const match =
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    out[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export function buildEnv(processEnv = process.env, helmDir = HELM) {
  const fromFiles = {};
  for (const name of ENV_FILES) {
    const path = join(helmDir, name);
    if (existsSync(path))
      Object.assign(fromFiles, parseDotenv(readFileSync(path, 'utf8')));
  }
  return { ...fromFiles, ...processEnv };
}

export function cspOverlay(baseCsp, env) {
  return {
    app: {
      security: {
        csp: {
          ...baseCsp,
          'connect-src': ["'self'", ...IPC, ...connectSources(env)].join(' '),
        },
      },
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = JSON.parse(readFileSync(CONF, 'utf8')).app.security.csp;
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    `${JSON.stringify(cspOverlay(base, buildEnv()), null, 2)}\n`,
  );
  process.stdout.write(`csp-config: wrote ${OUT}\n`);
}
