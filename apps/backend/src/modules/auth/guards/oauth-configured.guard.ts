import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotImplementedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ERROR_CODES } from '@tropis/shared';

export const OAUTH_PROVIDER_KEY = 'oauthProvider';

/**
 * Rejects OAuth routes whose provider has no credentials on this server.
 *
 * Must run BEFORE `AuthGuard('google'|'github')`: the strategies detect the
 * unconfigured case and call Passport's `fail({ message })`, but AuthGuard
 * discards that message and raises a plain UnauthorizedException, leaving the
 * caller with `401 Unauthorized` and no way to tell "wrong credentials" from
 * "this deployment has no Google login". A missing provider config is not an
 * authentication failure, so this answers 501 with an explicit code, mirroring
 * how the internal gRPC tier reports itself disabled.
 */
@Injectable()
export class OAuthConfiguredGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const provider = this.reflector.getAllAndOverride<string | undefined>(
      OAUTH_PROVIDER_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!provider) return true;

    const prefix = provider.toUpperCase();
    const clientId = this.config.get<string>(`${prefix}_CLIENT_ID`, '');
    const clientSecret = this.config.get<string>(`${prefix}_CLIENT_SECRET`, '');

    if (!clientId || !clientSecret) {
      throw new NotImplementedException({
        code: ERROR_CODES.OAUTH_NOT_CONFIGURED,
        message:
          `${provider} sign-in is not configured on this server ` +
          `(set ${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET)`,
      });
    }
    return true;
  }
}
