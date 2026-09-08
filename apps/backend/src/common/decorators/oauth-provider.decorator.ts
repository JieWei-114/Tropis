import { SetMetadata } from '@nestjs/common';
import { OAUTH_PROVIDER_KEY } from '../../modules/auth/guards/oauth-configured.guard';

/**
 * Names the OAuth provider a route belongs to, so OAuthConfiguredGuard can
 * check that this deployment actually has credentials for it.
 */
export const OAuthProvider = (provider: 'google' | 'github') =>
  SetMetadata(OAUTH_PROVIDER_KEY, provider);
