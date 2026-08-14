/**
 * Shared gRPC plumbing for the dev tools (ws-listen, …) — loads a service
 * client from the repo-root protos and promisifies unary calls, exactly the
 * way the backend listeners load them (keepCase preserved).
 *
 * Devtools owns this copy; apps/backend/scripts/lib/grpc.ts keeps a minimal
 * variant for the seeder — devtools is never imported by apps.
 */
import * as path from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export const HEALTH_URL = process.env.HEALTH_URL ?? 'http://localhost:3100/api/health';
export const GRPC_ADDRESS = process.env.GRPC_ADDRESS ?? 'localhost:50051';

// devtools/src/lib → repo root → proto/
export const PROTO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', 'proto');

export function loadService(
  protoRel: string,
  pkgPath: string[],
  service: string,
): grpc.ServiceClientConstructor {
  const def = protoLoader.loadSync(path.join(PROTO_ROOT, protoRel), {
    keepCase: true,
    longs: String,
    defaults: true,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any = grpc.loadPackageDefinition(def);
  for (const part of pkgPath) node = node[part];
  return node[service] as grpc.ServiceClientConstructor;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function call<T>(client: any, method: string, request: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    client[method](request, (err: grpc.ServiceError | null, res: T) =>
      err ? reject(err) : resolve(res),
    );
  });
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

/** Logs in over gRPC (AuthService/Login) and returns the JWT. */
export async function loginForToken(email: string, password: string): Promise<string> {
  const AuthService = loadService('auth/v1/auth.proto', ['app', 'auth', 'v1'], 'AuthService');
  const auth = new AuthService(GRPC_ADDRESS, grpc.credentials.createInsecure());
  try {
    const res = await call<{ access_token: string }>(auth, 'Login', { email, password });
    if (!res.access_token) throw new Error('login returned no access_token');
    return res.access_token;
  } finally {
    auth.close();
  }
}
