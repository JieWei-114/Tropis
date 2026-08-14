import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile, VerifyCallback } from 'passport-google-oauth20';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { OAuthUserProfile } from '../interfaces/oauth-profile.interface';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  private readonly configured: boolean;

  constructor(config: ConfigService) {
    const clientID = config.get<string>('GOOGLE_CLIENT_ID', '');
    const clientSecret = config.get<string>('GOOGLE_CLIENT_SECRET', '');

    // passport-google-oauth20 validates clientID in the constructor — supply a
    // placeholder so the class can be instantiated without credentials.
    // authenticate() is overridden below to fail fast when unconfigured.
    super({
      clientID: clientID || 'unconfigured',
      clientSecret: clientSecret || 'unconfigured',
      callbackURL: config.get<string>(
        'GOOGLE_CALLBACK_URL',
        'http://localhost:3100/api/auth/google/callback',
      ),
      scope: ['email', 'profile'],
    });

    this.configured = !!(clientID && clientSecret);
  }

  // Override authenticate so unconfigured routes fail with a clear message
  // instead of attempting an OAuth flow with dummy credentials.
  authenticate(req: Request, options?: object) {
    if (!this.configured) {
      (this as any).fail({
        message: 'Google OAuth is not configured on this server',
      });
      return;
    }
    super.authenticate(req, options);
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ): void {
    const email = profile.emails?.[0]?.value;
    if (!email)
      return done(new Error('Google account has no email address'), undefined);

    const user: OAuthUserProfile = {
      provider: 'google',
      providerId: profile.id,
      email,
      name: profile.displayName ?? email.split('@')[0],
    };

    done(null, user);
  }
}
