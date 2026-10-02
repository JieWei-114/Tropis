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
import {
  AccessTokenDto,
  CurrentUserDto,
  NativeSessionDto,
} from '../dto/auth-response.dto';
import { NativeLogoutDto, NativeRefreshDto } from '../dto/native-session.dto';
import { CookieCsrfGuard } from '../guards/cookie-csrf.guard';
import {
  NativeClientGuard,
  sessionClientOf,
} from '../guards/native-client.guard';
import { LogoutActorGuard } from '../guards/logout-actor.guard';
import type { SessionClient } from '../interfaces/session-client.interface';
import type { AuthTokens } from '../services/auth.service';
import {
  clearRefreshCookie,
  cookieSecure,
  refreshCookieOf,
  setRefreshCookie,
} from '../cookies/refresh-cookie';
import {
  oauthChallengeOf,
  oauthRedirectOf,
} from '../strategies/oauth-state.store';
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
 * flow. For the web console bodies carry the access token only; the refresh
 * token never reaches page script. The cookie endpoints (refresh, logout)
 * are CSRF-checked (CookieCsrfGuard).
 *
 * A native shell (`X-Tropis-Client: native` from a native origin,
 * sessionClientOf) gets the refresh token in the body of login and the
 * OAuth exchange instead of the cookie, and refreshes and logs out through
 * /auth/native/*.
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

  /**
   * Web: sets the refresh cookie and returns the access token only.
   * Native: returns both tokens and sets no cookie.
   */
  private session(
    res: Response,
    tokens: AuthTokens,
    client: SessionClient = 'web',
  ): AccessTokenDto | NativeSessionDto {
    if (client === 'native') {
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      };
    }
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
      'Login with email + password — returns the access token and sets the refresh cookie; a native shell gets both tokens in the body',
  })
  async login(
    @Body() dto: LoginDto,
    @Ip() ip: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccessTokenDto | NativeSessionDto> {
    const client = sessionClientOf(req);
    return this.session(
      res,
      await this.authService.login(this.tenantCtx.tenant, dto, ip),
      client,
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
  @UseGuards(CookieCsrfGuard, LogoutActorGuard)
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

  // ── Native shells ─────────────────────────────────────────────────────────

  @Public()
  @Post('native/refresh')
  @HttpCode(HttpStatus.OK)
  @UseGuards(NativeClientGuard)
  @Throttle({ refresh: {} })
  @ApiOperation({
    summary:
      'Native shells: rotate the refresh token from the body and return a new token pair',
  })
  async nativeRefresh(
    @Body() dto: NativeRefreshDto,
  ): Promise<NativeSessionDto> {
    const tokens = await this.authService.refresh(dto.refreshToken);
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  @Public()
  @Post('native/logout')
  @UseGuards(NativeClientGuard, LogoutActorGuard)
  @Audited('auth.logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Native shells: revoke the refresh token from the body and the current access token',
  })
  async nativeLogout(
    @Body() dto: NativeLogoutDto,
    @Req() req: Request,
  ): Promise<void> {
    const { principal } = await requestCredentials(req, this.verifier);
    await this.authService.logout(
      principal?.jti,
      principal?.exp,
      dto.refreshToken,
    );
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
      'Trade the one-time code from an OAuth callback and its PKCE verifier for an access token and the refresh cookie (native: both tokens in the body)',
  })
  async exchangeOAuthCode(
    @Body() dto: OAuthCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccessTokenDto | NativeSessionDto> {
    const client = sessionClientOf(req);
    return this.session(
      res,
      await this.oauthService.exchange(dto.code, dto.verifier, client),
      client,
    );
  }

  /**
   * Sends the browser back with a one-time code in the fragment: to the
   * console, or to the native callback URL the signed state carried.
   */
  private async finishOAuth(req: Request, res: Response, ip: string) {
    const profile = req.user as OAuthUserProfile;
    const challenge = oauthChallengeOf(req);
    if (!challenge) throw new AppError('OAUTH_STATE_INVALID');
    const redirect = oauthRedirectOf(req);
    const code = await this.oauthService.signIn(
      profile,
      ip,
      challenge,
      undefined,
      redirect ? 'native' : 'web',
    );
    const target = redirect ?? `${this.frontendUrl()}/auth/callback`;
    res.redirect(`${target}#code=${encodeURIComponent(code)}`);
  }

  // ── Google OAuth2 ─────────────────────────────────────────────────────────

  @Public()
  @Get('google')
  @OAuthProvider('google')
  @UseGuards(OAuthConfiguredGuard, AuthGuard('google'))
  @ApiOperation({
    summary:
      'Redirect to the Google consent screen (?challenge=base64url(SHA-256(verifier)); native shells add &redirect=<allowed callback URL>)',
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
      'Redirect to the GitHub consent screen (?challenge=base64url(SHA-256(verifier)); native shells add &redirect=<allowed callback URL>)',
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
