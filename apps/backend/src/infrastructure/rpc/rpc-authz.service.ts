import { Inject, Injectable } from '@nestjs/common';
import { createContextKey, type HandlerContext } from '@connectrpc/connect';
import { AppError } from '../../common/errors';
import type { TenantId } from '../../common/keyspace';
import {
  TOKEN_VERIFIER,
  bearerFromHeader,
  type Principal,
  type TokenVerifier,
} from '../../common/auth/token-verifier.port';
import { AuthorizationService } from '../../common/authz/authorization.service';
import { toConnectError } from './rpc-errors';

export interface RpcCaller {
  sub: string;
  email: string;
  roles: string[];
  tenantId: TenantId;
}

/**
 * What the authentication interceptor learned about the caller: the
 * presented bearer token, and either the verified principal or why the
 * token was rejected.
 */
export interface RpcCredentials {
  token?: string;
  principal?: Principal;
  error?: unknown;
}

export const RPC_CREDENTIALS = createContextKey<RpcCredentials>(
  {},
  { description: 'Bearer credentials of the current RPC' },
);

/** Bearer token from the `authorization` header, without the scheme. */
export function bearerToken(headers: Headers): string | undefined {
  return bearerFromHeader(headers.get('authorization'));
}

/**
 * Client address for lockout and sign-up counters, with the HTTP surface's
 * `trust proxy 1` semantics: the right-most X-Forwarded-For hop, the one the
 * single trusted proxy appended. Hops to its left are whatever the client
 * sent, so they are never used. Without the header, 'unknown'.
 */
export function rpcClientAddress(ctx: HandlerContext): string {
  const hops = (ctx.requestHeader.get('x-forwarded-for') ?? '')
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean);
  return hops[hops.length - 1] ?? 'unknown';
}

/** The caller the credentials name, or the reason there is none. */
export function callerOf(credentials: RpcCredentials): RpcCaller {
  const { token, principal, error } = credentials;
  if (!token) {
    throw toConnectError(
      new AppError('UNAUTHORIZED', { detail: 'Missing authorization token' }),
    );
  }
  if (!principal) {
    throw toConnectError(error ?? new AppError('AUTH_TOKEN_INVALID'));
  }
  return {
    sub: principal.userId,
    email: principal.email,
    roles: principal.roles,
    tenantId: principal.tenantId,
  };
}

/**
 * Token verification for RPC handlers. The authentication interceptor
 * verifies the bearer token once per call through the shared TokenVerifier
 * (signature, expiry, revocation, account status, tenant membership) and
 * stores the outcome in the handler context; @Authorize on a handler is
 * enforced by the authorization interceptor before it runs, and handlers
 * read the caller with `caller()`.
 */
@Injectable()
export class RpcAuthzService {
  constructor(
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    private readonly authorization: AuthorizationService,
  ) {}

  /** Reads and verifies the bearer token. Never throws. */
  async authenticate(headers: Headers): Promise<RpcCredentials> {
    const token = bearerToken(headers);
    if (!token) return {};
    try {
      return { token, principal: await this.verifier.verify(token) };
    } catch (error) {
      return { token, error };
    }
  }

  /** The authenticated caller, or the reason there is none. */
  caller(ctx: HandlerContext): RpcCaller {
    return callerOf(ctx.values.get(RPC_CREDENTIALS));
  }

  /**
   * The caller when the call carries a token, else undefined. A token that
   * does not verify is rejected rather than treated as anonymous.
   */
  optionalCaller(ctx: HandlerContext): RpcCaller | undefined {
    const { token } = ctx.values.get(RPC_CREDENTIALS);
    return token ? this.caller(ctx) : undefined;
  }

  /** Whether the caller's roles allow the action, for handlers that branch on it. */
  allows(
    caller: RpcCaller,
    resource: string,
    action: string,
  ): Promise<boolean> {
    return this.authorization.allows(caller.roles, { resource, action });
  }

  /** Bounds a caller-supplied page size so one RPC cannot ask for everything. */
  static clampLimit(
    value: number | undefined,
    fallback: number,
    max: number,
  ): number {
    const n = value && value > 0 ? value : fallback;
    return Math.min(n, max);
  }
}
