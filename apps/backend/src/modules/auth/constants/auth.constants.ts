import { defineKey } from '../../../common/keyspace';

/**
 * Revoked access-token ids (logout). Global: a jti is unique across tenants,
 * and the check runs before the tenant is trusted. TTL = the token's
 * remaining lifetime.
 */
export const TOKEN_REVOKED_KEY = defineKey({
  capability: 'kv',
  module: 'auth',
  name: 'token-revoked',
  version: 'v1',
});

/**
 * Live refresh tokens: forTenant(tenantId, userId, sha256(tokenId)). The key
 * holds a hash of the token id, so reading the store never yields a usable
 * refresh token (the client holds the raw id and its signature).
 */
export const REFRESH_TOKEN_KEY = defineKey({
  capability: 'kv',
  module: 'auth',
  name: 'refresh-token',
  version: 'v1',
});

/** Active session record per user: forTenant(tenantId, userId). */
export const SESSION_KEY = defineKey({
  capability: 'kv',
  module: 'auth',
  name: 'session',
  version: 'v1',
});

/** Failed logins per email across all IPs: forTenant(tenantId, email). */
export const LOGIN_EMAIL_RATE_LIMIT = defineKey({
  capability: 'ratelimit',
  module: 'auth',
  name: 'login-email',
  version: 'v1',
});

/** Failed logins per email and source IP: forTenant(tenantId, email, ip). */
export const LOGIN_IP_RATE_LIMIT = defineKey({
  capability: 'ratelimit',
  module: 'auth',
  name: 'login-ip',
  version: 'v1',
});

/**
 * Lockout marker set when a login-email or login-ip counter reaches its
 * threshold, read before the password is checked:
 * forTenant(tenantId, 'email', email) or forTenant(tenantId, 'ip', email, ip).
 */
export const LOGIN_LOCKOUT_KEY = defineKey({
  capability: 'kv',
  module: 'auth',
  name: 'login-lockout',
  version: 'v1',
});

/** RPC Login attempts per email: forTenant(tenantId, email). */
export const RPC_LOGIN_RATE_LIMIT = defineKey({
  capability: 'ratelimit',
  module: 'auth',
  name: 'rpc-login-email',
  version: 'v1',
});

export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export const LOCKOUT_MAX_ATTEMPTS = 5; // per email+IP (targeted brute force)
export const LOCKOUT_EMAIL_MAX = 30; // per email across ALL IPs (blunts IP rotation)
export const LOCKOUT_WINDOW_S = 15 * 60; // 15 minutes

export const RPC_LOGIN_RATE_LIMIT_POLICY = { limit: 10, windowSeconds: 60 };

/**
 * One-time OAuth sign-in codes: global(sha256(code)) -> { tenantId, userId }.
 * The callback redirect carries the code instead of a token; the browser
 * trades it once, within the TTL, for a token pair.
 */
export const OAUTH_SIGNIN_CODE_KEY = defineKey({
  capability: 'kv',
  module: 'auth',
  name: 'oauth-signin-code',
  version: 'v1',
});

export const OAUTH_SIGNIN_CODE_TTL_SECONDS = 60;

/** HttpOnly cookie holding the refresh token (docs/api-conventions.md). */
export const REFRESH_COOKIE = 'tropis_rt';

/** Path of the refresh cookie: only the auth endpoints ever receive it. */
export const REFRESH_COOKIE_PATH = '/api/auth';

/** Header the console sends on cookie endpoints; part of the CSRF check. */
export const CLIENT_HEADER = 'x-tropis-client';

/** Cookie binding an OAuth `state` to the browser that started the flow. */
export const OAUTH_STATE_COOKIE = 'tropis_oauth_state';

/** How long a sign-in may take between the redirect and the callback. */
export const OAUTH_STATE_TTL_SECONDS = 600;
