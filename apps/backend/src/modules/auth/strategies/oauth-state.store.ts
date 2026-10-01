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

type ChallengeRequest = Request & { [CHALLENGE]?: string };

/** The PKCE challenge the verified state carried, for the OAuth callback. */
export function oauthChallengeOf(req: Request): string | undefined {
  return (req as ChallengeRequest)[CHALLENGE];
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
 */
export class SignedOAuthStateStore {
  constructor(
    private readonly secret: string,
    private readonly now: () => number = Date.now,
  ) {}

  store(req: Request, _meta: unknown, callback: StoreCallback): void {
    const challenge = (req.query as Record<string, unknown> | undefined)
      ?.challenge;
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
    const payload = `${nonce}.${exp}.${challenge}`;
    setCookie(req, nonce, OAUTH_STATE_TTL_SECONDS);
    callback(null, `${payload}.${this.sign(payload)}`);
  }

  verify(req: Request, state: unknown, callback: VerifyCallback): void {
    const cookie = readCookie(req, OAUTH_STATE_COOKIE);
    setCookie(req, '', 0);
    const challenge = this.verifiedChallenge(state, cookie);
    if (challenge) {
      (req as ChallengeRequest)[CHALLENGE] = challenge;
      callback(null, true);
      return;
    }
    callback(new AppError('OAUTH_STATE_INVALID'));
  }

  private verifiedChallenge(
    state: unknown,
    cookie: string | undefined,
  ): string | undefined {
    if (typeof state !== 'string' || !cookie) return undefined;
    const [nonce, exp, challenge, sig, extra] = state.split('.');
    if (!nonce || !exp || !challenge || !sig || extra !== undefined) {
      return undefined;
    }
    if (!sameText(sig, this.sign(`${nonce}.${exp}.${challenge}`))) {
      return undefined;
    }
    if (!(Number(exp) * 1000 > this.now())) return undefined;
    if (!CHALLENGE_PATTERN.test(challenge)) return undefined;
    return sameText(nonce, cookie) ? challenge : undefined;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret)
      .update(`oauth-state\n${payload}`)
      .digest('base64url');
  }
}
