/**
 * SDK REPL — a Node REPL with the @tropis/sdk `createApi` facade preloaded and
 * already logged in, so you can poke the real backend interactively:
 *
 *   > await api.fetchUsers()
 *   > await api.fireEvent('button_click', 'me', { from: 'repl' })
 *
 * Transport note: the SDK's connect-web gRPC-Web transport needs a WHATWG
 * fetch — Node 20 ships one, and unary RPCs work fine over it, so the REPL
 * takes the exact browser path: SDK → Envoy :8090 (gRPC-Web) → backend
 * :50051. That means Envoy must be up (`make up`) as well as the backend
 * (`make dev`). Server-streaming calls (subscribeToStream) may not work
 * under Node's fetch — everything unary does.
 *
 * The SDK's token store expects `localStorage`; Node 20 has none, so a tiny
 * in-memory shim is installed before the SDK is imported.
 *
 * Login: admin@example.com / Password123! (the `make seed` admin) — override
 * with SDK_EMAIL / SDK_PASSWORD, or endpoints with GRPC_WEB_URL / REST_URL.
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

const GRPC_WEB_URL = process.env.GRPC_WEB_URL ?? 'http://localhost:8090';
const REST_URL = process.env.REST_URL ?? 'http://localhost:3100';
const EMAIL = process.env.SDK_EMAIL ?? 'admin@example.com';
const PASSWORD = process.env.SDK_PASSWORD ?? 'Password123!';

async function main(): Promise<void> {
  const api = createApi({
    grpcBaseUrl: GRPC_WEB_URL,
    restBaseUrl: REST_URL,
    getToken,
  });

  console.log(`Logging in as ${EMAIL} via ${GRPC_WEB_URL} (Envoy gRPC-Web)…`);
  try {
    await api.login(EMAIL, PASSWORD);
  } catch (err) {
    console.error(
      `✗ Login failed: ${err instanceof Error ? err.message : String(err)}` +
        `\n  Checklist: Envoy up? (make up) · backend up? (make dev) · admin seeded? (make seed)`,
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
