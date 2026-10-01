import { build } from 'esbuild';
import { readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';

/**
 * One bundle per role: dist/<role>/main.js, built from the tsc output in
 * dist/ (tsc emits the decorator metadata Nest DI needs, which esbuild
 * cannot). Each bundle holds only the source its root module reaches;
 * packages stay external and come from node_modules.
 */
const ROLES = ['public', 'private', 'worker', 'scheduler'];

/**
 * Temporal loads workflow definitions by path (require.resolve next to the
 * code that registers them) and bundles them itself, so every
 * `*.workflow.js` and the trace interceptors ship as files beside the worker
 * bundle, under their own base name.
 */
async function workflowEntries(dir = 'dist') {
  const entries = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dir === 'dist' && ROLES.includes(entry.name)) continue;
      Object.assign(entries, await workflowEntries(path));
    } else if (entry.name.endsWith('.workflow.js')) {
      const name = basename(entry.name, '.js');
      if (entries[name]) throw new Error(`Two workflow files named ${name}`);
      entries[name] = path;
    }
  }
  return entries;
}

const EXTRA_ENTRIES = {
  worker: {
    ...(await workflowEntries()),
    'temporal-interceptors':
      'dist/infrastructure/workflow/adapters/temporal/temporal-interceptors.js',
  },
};

for (const role of ROLES) {
  const outdir = `dist/${role}`;
  await rm(outdir, { recursive: true, force: true });
  await build({
    entryPoints: {
      main: `dist/roles/${role}/main.js`,
      ...(EXTRA_ENTRIES[role] ?? {}),
    },
    outdir,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    packages: 'external',
    // Loaded by path at runtime (require.resolve), from the files above.
    external: ['./*.workflow', './temporal-interceptors'],
    keepNames: true,
    sourcemap: true,
    logLevel: 'warning',
  });
}
