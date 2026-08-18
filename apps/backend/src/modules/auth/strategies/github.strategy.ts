import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback } from 'passport-oauth2';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { OAuthUserProfile } from '../interfaces/oauth-profile.interface';

// Uses passport-oauth2 (maintained) instead of the abandoned passport-github2 /
// unmaintained passport-github. GitHub's OAuth2 endpoints are standard; no
// GitHub-specific Passport package is needed.
@Injectable()
export class GithubStrategy extends PassportStrategy(Strategy, 'github') {
  private readonly configured: boolean;

  constructor(config: ConfigService) {
    const clientID = config.get<string>('GITHUB_CLIENT_ID', '');
    const clientSecret = config.get<string>('GITHUB_CLIENT_SECRET', '');

    super({
      authorizationURL: 'https://github.com/login/oauth/authorize',
      tokenURL: 'https://github.com/login/oauth/access_token',
      clientID: clientID || 'unconfigured',
      clientSecret: clientSecret || 'unconfigured',
      callbackURL: config.get<string>(
        'GITHUB_CALLBACK_URL',
        'http://localhost:3100/api/auth/github/callback',
      ),
      scope: ['user:email'],
    });

    this.configured = !!(clientID && clientSecret);
  }

  authenticate(req: Request, options?: object) {
    if (!this.configured) {
      (this as any).fail({
        message: 'GitHub OAuth is not configured on this server',
      });
      return;
    }
    super.authenticate(req, options);
  }

  async validate(
    accessToken: string,
    _refreshToken: string,
    _profile: unknown,
    done: VerifyCallback,
  ): Promise<void> {
    try {
      const [userRes, emailsRes] = await Promise.all([
        fetch('https://api.github.com/user', {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'User-Agent': 'tropis',
          },
        }),
        fetch('https://api.github.com/user/emails', {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'User-Agent': 'tropis',
          },
        }),
      ]);

      const githubUser = (await userRes.json()) as {
        id: number;
        login: string;
        name?: string;
      };
      const emails = (await emailsRes.json()) as Array<{
        email: string;
        primary: boolean;
        verified: boolean;
      }>;

      const primary = emails.find((e) => e.primary && e.verified);
      if (!primary) {
        done(new Error('GitHub account has no verified primary email address'));
        return;
      }

      const profile: OAuthUserProfile = {
        provider: 'github',
        providerId: String(githubUser.id),
        email: primary.email,
        name:
          githubUser.name ?? githubUser.login ?? primary.email.split('@')[0],
        emailVerified: true, // guaranteed by the `primary && verified` filter above
      };

      done(null, profile);
    } catch (err) {
      done(err as Error);
    }
  }
}
