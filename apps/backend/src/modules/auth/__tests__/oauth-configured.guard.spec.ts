import { NotImplementedException, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import {
  OAuthConfiguredGuard,
  OAUTH_PROVIDER_KEY,
} from '../guards/oauth-configured.guard';

/**
 * Pins the "not configured is not an auth failure" contract: a deployment
 * without OAuth credentials must answer 501 with an actionable code. Left to
 * AuthGuard, the route answers `401 Unauthorized` — indistinguishable from a
 * rejected sign-in, since AuthGuard discards the strategy's fail message.
 */
describe('OAuthConfiguredGuard', () => {
  const context = (provider?: string): ExecutionContext =>
    ({
      getHandler: () => function googleLogin() {},
      getClass: () => class AuthController {},
      __provider: provider,
    }) as unknown as ExecutionContext;

  const build = (provider: string | undefined, env: Record<string, string>) => {
    const reflector = {
      getAllAndOverride: (key: string) =>
        key === OAUTH_PROVIDER_KEY ? provider : undefined,
    } as unknown as Reflector;
    const config = {
      get: (key: string, fallback = '') => env[key] ?? fallback,
    } as unknown as ConfigService;
    return new OAuthConfiguredGuard(reflector, config);
  };

  it('passes through routes that are not OAuth routes', () => {
    expect(build(undefined, {}).canActivate(context())).toBe(true);
  });

  it('throws 501 with an actionable code when credentials are absent', () => {
    const guard = build('google', {});

    try {
      guard.canActivate(context('google'));
      throw new Error('expected the guard to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NotImplementedException);
      const body = (err as NotImplementedException).getResponse() as {
        code: string;
        message: string;
      };
      expect(body.code).toBe('OAUTH_NOT_CONFIGURED');
      // The message must name the variables an operator has to set.
      expect(body.message).toContain('GOOGLE_CLIENT_ID');
      expect(body.message).toContain('GOOGLE_CLIENT_SECRET');
    }
  });

  it('throws when only one half of the credential pair is set', () => {
    const guard = build('github', { GITHUB_CLIENT_ID: 'id-only' });

    expect(() => guard.canActivate(context('github'))).toThrow(
      NotImplementedException,
    );
  });

  it('allows the route once both credentials are present', () => {
    const guard = build('google', {
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
    });

    expect(guard.canActivate(context('google'))).toBe(true);
  });
});
