import { Injectable } from '@nestjs/common';
import { UserRepository } from '../../user/repositories/user.repository';
import { AuthService } from './auth.service';
import { OAuthUserProfile } from '../interfaces/oauth-profile.interface';
import { DEFAULT_TENANT } from '../../user/schemas/user.schema';

/**
 * Handles the OAuth "find or create" flow.
 *
 * On first OAuth login:
 *   - Look up user by (provider, providerId, tenantId)
 *   - If not found, look up by email (user may have previously registered with password)
 *   - If still not found, create a new account (no passwordHash — OAuth-only users)
 *   - Issue a signed app JWT
 *
 * On subsequent OAuth logins:
 *   - Found by (provider, providerId) → issue fresh JWT
 */
@Injectable()
export class OAuthService {
  constructor(
    private readonly userRepo: UserRepository,
    private readonly authService: AuthService,
  ) {}

  async findOrCreate(
    profile: OAuthUserProfile,
    tenantId = DEFAULT_TENANT,
  ): Promise<{ accessToken: string }> {
    // 1. Exact match by provider identity
    let user = await this.userRepo.findByProvider(
      profile.provider,
      profile.providerId,
      tenantId,
    );

    // 2. Email match — link provider to an existing password-based account
    if (!user) {
      user = await this.userRepo.findByEmail(profile.email, tenantId);
      if (user) {
        user = await this.userRepo.update(
          user._id.toString(),
          { provider: profile.provider, providerId: profile.providerId },
          tenantId,
        );
      }
    }

    // 3. Brand new user — create account without password
    if (!user) {
      user = await this.userRepo.create({
        name: profile.name,
        email: profile.email,
        passwordHash: '', // OAuth users have no local password
        provider: profile.provider,
        providerId: profile.providerId,
        tenantId,
      });
    }

    return { accessToken: this.authService.issueToken(user) };
  }
}
