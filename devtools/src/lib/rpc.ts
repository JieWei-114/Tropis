/**
 * Shared RPC plumbing for the dev tools (ws-listen, …): a health check and a
 * login through the @tropis/sdk Connect clients, the same path the browser
 * takes to the backend's public RPC listener.
 *
 * Devtools owns this copy; apps/backend/scripts/lib/rpc.ts keeps a minimal
 * variant for the seeder — devtools is never imported by apps.
 */
import { createSdk } from '@tropis/sdk';

const HEALTH_URL = process.env.HEALTH_URL ?? 'http://localhost:3100/api/health';
const RPC_URL = process.env.RPC_URL ?? 'http://localhost:50051';
export const TENANT_ID = process.env.TENANT_ID ?? 'dev';

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

/** Logs in over RPC (AuthService/Login) and returns the access token. */
export async function loginForToken(
  email: string,
  password: string,
): Promise<string> {
  const { auth } = createSdk({ baseUrl: RPC_URL, tenantId: TENANT_ID });
  const res = await auth.login({ email, password });
  if (!res.accessToken) throw new Error('login returned no access token');
  return res.accessToken;
}
