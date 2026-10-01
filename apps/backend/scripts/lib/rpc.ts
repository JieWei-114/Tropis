/**
 * Minimal RPC plumbing for the seeder (scripts/seed.ts) and the workflow demo
 * (scripts/create-demo-user.ts): Connect clients over the buf-generated
 * service types in src/gen, calling the backend's public RPC listener.
 *
 * Kept intentionally to only what those scripts need; the dev tools
 * (ws-listen, outbox-status, sdk-repl) live in devtools/ with their own helper.
 */
import {
  createClient,
  type Client,
  type Interceptor,
} from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import type { DescService } from '@bufbuild/protobuf';

export const HEALTH_URL =
  process.env.HEALTH_URL ?? 'http://localhost:3100/api/health';
export const RPC_URL = process.env.RPC_URL ?? 'http://localhost:50051';
/** The tenant every script call runs in; matches helm's VITE_TENANT_ID default. */
export const TENANT_ID = process.env.TENANT_ID ?? 'dev';

const withTenant: Interceptor = (next) => (req) => {
  req.header.set('x-tenant-id', TENANT_ID);
  return next(req);
};

const transport = createConnectTransport({
  baseUrl: RPC_URL,
  httpVersion: '1.1',
  interceptors: [withTenant],
});

export function rpcClient<T extends DescService>(service: T): Client<T> {
  return createClient(service, transport);
}

/**
 * Bearer header for the authenticated RPCs.
 *
 * The analytics service requires a token, so scripts that write events have
 * to sign in first.
 */
export function bearer(token: string): { headers: Record<string, string> } {
  return { headers: { authorization: `Bearer ${token}` } };
}

/** Logs in over REST and returns the access token. */
export async function loginForToken(
  email: string,
  password: string,
): Promise<string> {
  const base = HEALTH_URL.replace(/\/health$/, '');
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': TENANT_ID },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`login failed for ${email}: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { accessToken?: string };
  if (!body.accessToken) throw new Error('login returned no accessToken');
  return body.accessToken;
}

/** Exits with a friendly hint when the backend is not up (`make up && make dev`). */
export async function checkHealth(): Promise<void> {
  try {
    const res = await fetch(HEALTH_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error(
      `\n✗ Backend is not healthy at ${HEALTH_URL}` +
        `\n  (${err instanceof Error ? err.message : String(err)})` +
        `\n\n  Start the stack first:` +
        `\n    make up     # core infra containers` +
        `\n    make dev    # backend + frontend + worker\n`,
    );
    process.exit(1);
  }
}
