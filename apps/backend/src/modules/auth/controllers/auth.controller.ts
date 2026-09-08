import {
  Controller,
  Post,
  Body,
  Get,
  UseGuards,
  Req,
  Res,
  Ip,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { OAuthProvider } from '../../../common/decorators/oauth-provider.decorator';
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
import { RefreshTokenDto } from '../dto/refresh-token.dto';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { Public } from '../../../common/decorators/public.decorator';
import { Audited } from '../../../common/decorators/audited.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { OAuthUserProfile } from '../interfaces/oauth-profile.interface';
import { primaryWebOrigin } from '../../../config/cors.constants';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly oauthService: OAuthService,
    private readonly config: ConfigService,
  ) {}

  /** OAuth providers redirect a real browser here, so it must be a single
   *  web origin — never the native-shell entries in the CORS allow-list. */
  private frontendUrl(): string {
    return primaryWebOrigin();
  }

  // ── Password login ────────────────────────────────────────────────────────

  @Public()
  @Post('login')
  @Audited('auth.login')
  @Throttle({ auth: {} }) // RATE_LIMIT_AUTH per RATE_LIMIT_TTL_MS, per IP
  @ApiOperation({
    summary:
      'Login with email + password — returns JWT access + refresh tokens',
  })
  login(@Body() dto: LoginDto, @Ip() ip: string) {
    return this.authService.login(dto, ip);
  }

  // ── Token refresh ─────────────────────────────────────────────────────────

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ auth: {} })
  @ApiOperation({
    summary:
      'Exchange a valid refresh token for a new access + refresh token pair',
  })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  // ── Logout ────────────────────────────────────────────────────────────────

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @Audited('auth.logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Revoke current access token and paired refresh token',
  })
  async logout(
    @CurrentUser() user: { jti: string; exp: number },
    // Optional, and read with `?.` below: a caller that sends no body at all
    // (no content-type) leaves this undefined, and logout must still revoke
    // the access token rather than fail on a property access.
    @Body() body?: Partial<RefreshTokenDto>,
  ): Promise<void> {
    await this.authService.logout(user.jti, user.exp, body?.refreshToken);
  }

  // ── Whoami ────────────────────────────────────────────────────────────────

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('me')
  @ApiOperation({ summary: 'Get current user identity from JWT' })
  me(@CurrentUser() user: { userId: string; email: string; tenantId: string }) {
    return user;
  }

  // ── Google OAuth2 ─────────────────────────────────────────────────────────

  @Public()
  @Get('google')
  @OAuthProvider('google')
  @UseGuards(OAuthConfiguredGuard, AuthGuard('google'))
  @ApiOperation({ summary: 'Redirect to Google OAuth2 consent screen' })
  googleLogin() {
    // Passport redirects — this handler body never executes
  }

  @Public()
  @Get('google/callback')
  @OAuthProvider('google')
  @UseGuards(OAuthConfiguredGuard, AuthGuard('google'))
  @Throttle({ auth: {} })
  @ApiExcludeEndpoint()
  async googleCallback(@Req() req: Request, @Res() res: Response) {
    const profile = req.user as OAuthUserProfile;
    const { accessToken } = await this.oauthService.findOrCreate(profile);
    res.redirect(`${this.frontendUrl()}/auth/callback?token=${accessToken}`);
  }

  // ── GitHub OAuth2 ─────────────────────────────────────────────────────────

  @Public()
  @Get('github')
  @OAuthProvider('github')
  @UseGuards(OAuthConfiguredGuard, AuthGuard('github'))
  @ApiOperation({ summary: 'Redirect to GitHub OAuth2 consent screen' })
  githubLogin() {
    // Passport redirects — this handler body never executes
  }

  @Public()
  @Get('github/callback')
  @OAuthProvider('github')
  @UseGuards(OAuthConfiguredGuard, AuthGuard('github'))
  @Throttle({ auth: {} })
  @ApiExcludeEndpoint()
  async githubCallback(@Req() req: Request, @Res() res: Response) {
    const profile = req.user as OAuthUserProfile;
    const { accessToken } = await this.oauthService.findOrCreate(profile);
    res.redirect(`${this.frontendUrl()}/auth/callback?token=${accessToken}`);
  }
}
