import {
  Controller,
  Post,
  Body,
  Get,
  Inject,
  UseGuards,
  Req,
  Res,
  Ip,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { OAuthProvider } from '../decorators/oauth-provider.decorator';
import { OAuthConfiguredGuard } from '../guards/oauth-configured.guard';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiExcludeEndpoint,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../services/auth.service';
import { OAuthService } from '../services/oauth.service';
import { LoginDto } from '../dto/login.dto';
import { OAuthCodeDto } from '../dto/oauth-code.dto';
import { AccessTokenDto, CurrentUserDto } from '../dto/auth-response.dto';
import { CookieCsrfGuard } from '../guards/cookie-csrf.guard';
import type { AuthTokens } from '../services/auth.service';
import {
  clearRefreshCookie,
  cookieSecure,
  refreshCookieOf,
  setRefreshCookie,
} from '../cookies/refresh-cookie';
import { oauthChallengeOf } from '../strategies/oauth-state.store';
import { AppError, isAppError } from '../../../common/errors';
import { requestCredentials } from '../../../common/auth/request-credentials';
import {
  TOKEN_VERIFIER,
  type Principal,
  type TokenVerifier,
} from '../../../common/auth/token-verifier.port';
import { Public } from '../../../common/decorators/public.decorator';
import { Audited } from '../../../common/audit/audited.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { OAuthUserProfile } from '../interfaces/oauth-profile.interface';
import { primaryWebOrigin } from '../../../config/cors.constants';
import { TenantContext } from '../../../common/tenant/tenant.context';

/**
 * REST auth: password login, the refresh cookie (`tropis_rt`, HttpOnly,
 * SameSite=Strict, Path=/api/auth), logout, whoami and the OAuth redirect
 * flow. Bodies carry the access token only; the refresh token never reaches
 * page script. The cookie endpoints (refresh, logout) are CSRF-checked
 * (CookieCsrfGuard).
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly secureCookie: boolean;

  constructor(
    private readonly authService: AuthService,
    private readonly oauthService: OAuthService,
    config: ConfigService,
    private readonly tenantCtx: TenantContext,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
  ) {
    this.secureCookie = cookieSecure(config);
  }

  /** OAuth providers redirect a real browser here, so it must be a single
   *  web origin — never the native-shell entries in the CORS allow-list. */
  private frontendUrl(): string {
    return primaryWebOrigin();
  }

  /** Sets the refresh cookie and returns the body: the access token only. */
  private session(res: Response, tokens: AuthTokens): AccessTokenDto {
    setRefreshCookie(res, tokens.refreshToken, this.secureCookie);
    return { accessToken: tokens.accessToken };
  }

  // ── Password login ────────────────────────────────────────────────────────

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Audited('auth.login')
  @Throttle({ auth: {} }) // RATE_LIMIT_AUTH per RATE_LIMIT_TTL_MS, per IP
  @ApiOperation({
    summary:
      'Login with email + password — returns the access token and sets the refresh cookie',
  })
  async login(
    @Body() dto: LoginDto,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccessTokenDto> {
    return this.session(
      res,
      await this.authService.login(this.tenantCtx.tenant, dto, ip),
    );
  }

  // ── Token refresh ─────────────────────────────────────────────────────────

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CookieCsrfGuard)
  @Throttle({ refresh: {} })
  @ApiOperation({
    summary:
      'Rotate the refresh cookie and return a new access token; 204 when there is no session cookie (no body; CSRF-checked)',
  })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccessTokenDto | undefined> {
    const token = refreshCookieOf(req);
    if (!token) {
      res.status(HttpStatus.NO_CONTENT);
      return undefined;
    }
    try {
      return this.session(res, await this.authService.refresh(token));
    } catch (err) {
      // Only a refused token ends the session; an outage keeps the cookie.
      if (isAppError(err) && err.definition.httpStatus === 401) {
        clearRefreshCookie(res, this.secureCookie);
      }
      throw err;
    }
  }

  // ── Logout ────────────────────────────────────────────────────────────────

  @Public()
  @Post('logout')
  @UseGuards(CookieCsrfGuard)
  @Audited('auth.logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Revoke the refresh cookie and the current access token, and clear the cookie (CSRF-checked)',
  })
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const { principal } = await requestCredentials(req, this.verifier);
    await this.authService.logout(
      principal?.jti,
      principal?.exp,
      refreshCookieOf(req),
    );
    clearRefreshCookie(res, this.secureCookie);
  }

  // ── Whoami ────────────────────────────────────────────────────────────────

  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'The signed-in user: id, email, tenant and roles' })
  me(@CurrentUser() user: Principal): CurrentUserDto {
    return {
      userId: user.userId,
      email: user.email,
      tenantId: user.tenantId,
      roles: [...user.roles],
    };
  }

  // ── OAuth sign-in code ────────────────────────────────────────────────────

  @Public()
  @Post('oauth/exchange')
  @HttpCode(HttpStatus.OK)
  @Throttle({ auth: {} })
  @ApiOperation({
    summary:
      'Trade the one-time code from an OAuth callback and its PKCE verifier for an access token and the refresh cookie',
  })
  async exchangeOAuthCode(
    @Body() dto: OAuthCodeDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccessTokenDto> {
    return this.session(
      res,
      await this.oauthService.exchange(dto.code, dto.verifier),
    );
  }

  /** Sends the browser back to the console with a one-time code in the fragment. */
  private async finishOAuth(req: Request, res: Response, ip: string) {
    const profile = req.user as OAuthUserProfile;
    const challenge = oauthChallengeOf(req);
    if (!challenge) throw new AppError('OAUTH_STATE_INVALID');
    const code = await this.oauthService.signIn(profile, ip, challenge);
    res.redirect(
      `${this.frontendUrl()}/auth/callback#code=${encodeURIComponent(code)}`,
    );
  }

  // ── Google OAuth2 ─────────────────────────────────────────────────────────

  @Public()
  @Get('google')
  @OAuthProvider('google')
  @UseGuards(OAuthConfiguredGuard, AuthGuard('google'))
  @ApiOperation({
    summary:
      'Redirect to the Google consent screen (?challenge=base64url(SHA-256(verifier)))',
  })
  googleLogin() {
    // Passport redirects — this handler body never executes
  }

  @Public()
  @Get('google/callback')
  @OAuthProvider('google')
  @UseGuards(OAuthConfiguredGuard, AuthGuard('google'))
  @Throttle({ auth: {} })
  @ApiExcludeEndpoint()
  googleCallback(@Req() req: Request, @Res() res: Response, @Ip() ip: string) {
    return this.finishOAuth(req, res, ip);
  }

  // ── GitHub OAuth2 ─────────────────────────────────────────────────────────

  @Public()
  @Get('github')
  @OAuthProvider('github')
  @UseGuards(OAuthConfiguredGuard, AuthGuard('github'))
  @ApiOperation({
    summary:
      'Redirect to the GitHub consent screen (?challenge=base64url(SHA-256(verifier)))',
  })
  githubLogin() {
    // Passport redirects — this handler body never executes
  }

  @Public()
  @Get('github/callback')
  @OAuthProvider('github')
  @UseGuards(OAuthConfiguredGuard, AuthGuard('github'))
  @Throttle({ auth: {} })
  @ApiExcludeEndpoint()
  githubCallback(@Req() req: Request, @Res() res: Response, @Ip() ip: string) {
    return this.finishOAuth(req, res, ip);
  }
}
