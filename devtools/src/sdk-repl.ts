/**
 * SDK REPL — a Node REPL with the @tropis/sdk `createApi` facade preloaded and
 * already logged in, so you can poke the real backend interactively:
 *
 *   > await api.fetchUsers()
 *   > await api.fireEvent('button_click', 'me', { from: 'repl' })
 *
 * Transport note: the SDK's connect-web Connect transport needs a WHATWG
 * fetch — Node 22 ships one, so the REPL takes the exact browser path:
 * SDK → backend public RPC listener :50051 (Connect protocol), no proxy in
 * between. Only the backend has to be up (`make dev`). Every RPC the facade
 * exposes is unary, so all of them work over Node's fetch. Live event streams
 * are WebSocket, not RPC — use `make ws-listen` for those.
 *
 * The SDK's token store expects `localStorage`; Node has none, so a tiny
 * in-memory shim is installed before the SDK is imported.
 *
 * Login: admin@example.com / Password123! (the `make seed` admin) — override
 * with SDK_EMAIL / SDK_PASSWORD, or endpoints with RPC_URL / REST_URL.
 *
 * Run: `make sdk-repl`  (→ pnpm --filter @tropis/devtools sdk-repl — uses tsx,
 * not ts-node, because the SDK is an ESM TypeScript workspace package).
 */

// localStorage shim — MUST be in place before the SDK module initialises.
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};

import * as repl from 'node:repl';
import { createApi, getToken } from '@tropis/sdk';

const RPC_URL = process.env.RPC_URL ?? 'http://localhost:50051';
const REST_URL = process.env.REST_URL ?? 'http://localhost:3100';
const EMAIL = process.env.SDK_EMAIL ?? 'admin@example.com';
const PASSWORD = process.env.SDK_PASSWORD ?? 'Password123!';

async function main(): Promise<void> {
  const api = createApi({
    rpcBaseUrl: RPC_URL,
    restBaseUrl: REST_URL,
    getToken,
    tenantId: process.env.TENANT_ID ?? 'dev',
  });

  console.log(`Logging in as ${EMAIL} (RPC ${RPC_URL}, REST ${REST_URL})…`);
  try {
    await api.login(EMAIL, PASSWORD);
  } catch (err) {
    console.error(
      `✗ Login failed: ${err instanceof Error ? err.message : String(err)}` +
        `\n  Checklist: backend up? (make dev) · user seeded? (make seed)`,
    );
    process.exit(1);
  }

  const methods = Object.keys(api).filter(
    (k) => typeof (api as unknown as Record<string, unknown>)[k] === 'function',
  );
  console.log(
    `\n✓ Logged in. In scope: \`api\` (the SDK facade) and \`token\` (the JWT).` +
      `\n  Methods: ${methods.join(', ')}` +
      `\n  Example: await api.fetchUsers()\n`,
  );

  const r = repl.start({ prompt: 'sdk> ' });
  r.context.api = api;
  r.context.token = getToken();
  r.on('exit', () => process.exit(0));
}

void main();
