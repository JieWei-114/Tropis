import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { AppError } from '../../../common/errors';
import { readCookie } from '../cookies/refresh-cookie';
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_SECONDS,
} from '../constants/auth.constants';

const COOKIE_PATH = '/api/auth';

/** base64url of a SHA-256 digest: 43 characters, no padding. */
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const CHALLENGE = Symbol('oauthChallenge');
const REDIRECT = Symbol('oauthRedirect');

type ChallengeRequest = Request & {
  [CHALLENGE]?: string;
  [REDIRECT]?: string;
};

/** The PKCE challenge the verified state carried, for the OAuth callback. */
export function oauthChallengeOf(req: Request): string | undefined {
  return (req as ChallengeRequest)[CHALLENGE];
}

/**
 * The native-shell callback URL the verified state carried, or undefined
 * for a web sign-in.
 */
export function oauthRedirectOf(req: Request): string | undefined {
  return (req as ChallengeRequest)[REDIRECT];
}

type StoreCallback = (err: Error | null, state?: string) => void;
type VerifyCallback = (err: Error | null, ok?: boolean) => void;

function setCookie(req: Request, value: string, maxAge: number): void {
  const res = (req as Request & { res?: Response }).res;
  const secure = req.secure ? '; Secure' : '';
  res?.append(
    'Set-Cookie',
    `${OAUTH_STATE_COOKIE}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax${secure}`,
  );
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Stateless CSRF protection for the OAuth redirect flow (passport-oauth2
 * state store). The flow starts with `?challenge=<base64url(SHA-256(verifier))>`
 * (400 VALIDATION_FAILED without a well-formed one); the `state` sent to the
 * provider is `nonce.exp.challenge.hmac`, and the nonce is also set in an
 * HttpOnly cookie on the browser that started the flow. The callback is
 * accepted only with an untampered, unexpired state whose nonce matches that
 * browser's cookie, so an attacker cannot make a victim's browser finish a
 * sign-in the attacker started; the challenge then binds the one-time code
 * to the verifier only that browser holds.
 *
 * A native shell adds `&redirect=<custom-scheme URL>`, which must equal an
 * entry of `nativeRedirects` (NATIVE_OAUTH_REDIRECTS), else 400
 * VALIDATION_FAILED: never an arbitrary URL. The redirect is signed into the
 * state (`nonce.exp.challenge.base64url(redirect).hmac`), checked against
 * the allow-list again at the callback, and the callback returns there.
 */
export class SignedOAuthStateStore {
  constructor(
    private readonly secret: string,
    private readonly now: () => number = Date.now,
    private readonly nativeRedirects: readonly string[] = [],
  ) {}

  store(req: Request, _meta: unknown, callback: StoreCallback): void {
    const query = req.query as Record<string, unknown> | undefined;
    const challenge = query?.challenge;
    const redirect = query?.redirect;
    if (
      redirect !== undefined &&
      (typeof redirect !== 'string' || !this.nativeRedirects.includes(redirect))
    ) {
      callback(
        AppError.validation([
          {
            field: 'redirect',
            description:
              'redirect must be one of the configured native callback URLs',
          },
        ]),
      );
      return;
    }
    if (typeof challenge !== 'string' || !CHALLENGE_PATTERN.test(challenge)) {
      callback(
        AppError.validation([
          {
            field: 'challenge',
            description:
              'challenge must be base64url(SHA-256(verifier)), 43 characters',
          },
        ]),
      );
      return;
    }
    const nonce = randomBytes(16).toString('base64url');
    const exp = Math.floor(this.now() / 1000) + OAUTH_STATE_TTL_SECONDS;
    const payload =
      typeof redirect === 'string'
        ? `${nonce}.${exp}.${challenge}.${Buffer.from(redirect).toString('base64url')}`
        : `${nonce}.${exp}.${challenge}`;
    setCookie(req, nonce, OAUTH_STATE_TTL_SECONDS);
    callback(null, `${payload}.${this.sign(payload)}`);
  }

  verify(req: Request, state: unknown, callback: VerifyCallback): void {
    const cookie = readCookie(req, OAUTH_STATE_COOKIE);
    setCookie(req, '', 0);
    const verified = this.verifiedState(state, cookie);
    if (verified) {
      (req as ChallengeRequest)[CHALLENGE] = verified.challenge;
      if (verified.redirect) {
        (req as ChallengeRequest)[REDIRECT] = verified.redirect;
      }
      callback(null, true);
      return;
    }
    callback(new AppError('OAUTH_STATE_INVALID'));
  }

  private verifiedState(
    state: unknown,
    cookie: string | undefined,
  ): { challenge: string; redirect?: string } | undefined {
    if (typeof state !== 'string' || !cookie) return undefined;
    const parts = state.split('.');
    if (parts.length !== 4 && parts.length !== 5) return undefined;
    if (parts.some((p) => !p)) return undefined;
    const sig = parts.pop()!;
    const [nonce, exp, challenge, encodedRedirect] = parts;
    if (!sameText(sig, this.sign(parts.join('.')))) return undefined;
    if (!(Number(exp) * 1000 > this.now())) return undefined;
    if (!CHALLENGE_PATTERN.test(challenge)) return undefined;
    if (!sameText(nonce, cookie)) return undefined;
    if (encodedRedirect === undefined) return { challenge };
    const redirect = Buffer.from(encodedRedirect, 'base64url').toString('utf8');
    if (!this.nativeRedirects.includes(redirect)) return undefined;
    return { challenge, redirect };
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret)
      .update(`oauth-state\n${payload}`)
      .digest('base64url');
  }
}
