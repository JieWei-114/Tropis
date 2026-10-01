/**
 * Validated environment config.
 *
 * Reads Vite env vars once at module load, applies defaults for local dev,
 * and warns when a default is used so misconfiguration is visible in the
 * console instead of silently pointing at localhost.
 */

interface Env {
  /** Backend RPC endpoint (Connect protocol, public listener). */
  VITE_RPC_URL: string;
  /** Socket.io gateway URL. */
  VITE_WS_URL: string;
  /** REST API base URL. */
  VITE_API_BASE_URL: string;
  /** Public site origin, used to build absolute canonical/OG URLs for SEO. */
  VITE_SITE_URL: string;
  /** Tenant this console signs in to, sent as X-Tenant-ID. */
  VITE_TENANT_ID: string;
}

const DEFAULTS: Env = {
  VITE_RPC_URL: 'http://localhost:50051',
  VITE_WS_URL: 'http://localhost:3100',
  VITE_API_BASE_URL: 'http://localhost:3100',
  VITE_SITE_URL: 'http://localhost:5173',
  VITE_TENANT_ID: 'dev',
};

function readVar(key: keyof Env): string {
  const raw = import.meta.env[key];
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  console.warn(
    `[env] ${key} is not set — falling back to default "${DEFAULTS[key]}"`,
  );
  return DEFAULTS[key];
}

export const env: Env = {
  VITE_RPC_URL: readVar('VITE_RPC_URL'),
  VITE_WS_URL: readVar('VITE_WS_URL'),
  VITE_API_BASE_URL: readVar('VITE_API_BASE_URL'),
  VITE_SITE_URL: readVar('VITE_SITE_URL'),
  VITE_TENANT_ID: readVar('VITE_TENANT_ID'),
};
