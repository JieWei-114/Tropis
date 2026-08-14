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
import { corsOriginFromEnv } from '../../../config/cors.constants';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly oauthService: OAuthService,
    private readonly config: ConfigService,
  ) {}

  private frontendUrl(): string {
    return corsOriginFromEnv();
  }

  // ── Password login ────────────────────────────────────────────────────────

  @Public()
  @Post('login')
  @Audited('auth.login')
  @Throttle({ default: { limit: 10, ttl: 60_000 } }) // 10 attempts per minute per IP
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
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
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
    @Body() body: Partial<RefreshTokenDto>,
  ): Promise<void> {
    await this.authService.logout(user.jti, user.exp, body.refreshToken);
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
  @UseGuards(AuthGuard('google'))
  @ApiOperation({ summary: 'Redirect to Google OAuth2 consent screen' })
  googleLogin() {
    // Passport redirects — this handler body never executes
  }

  @Public()
  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  async googleCallback(@Req() req: Request, @Res() res: Response) {
    const profile = req.user as OAuthUserProfile;
    const { accessToken } = await this.oauthService.findOrCreate(profile);
    res.redirect(`${this.frontendUrl()}/auth/callback?token=${accessToken}`);
  }

  // ── GitHub OAuth2 ─────────────────────────────────────────────────────────

  @Public()
  @Get('github')
  @UseGuards(AuthGuard('github'))
  @ApiOperation({ summary: 'Redirect to GitHub OAuth2 consent screen' })
  githubLogin() {
    // Passport redirects — this handler body never executes
  }

  @Public()
  @Get('github/callback')
  @UseGuards(AuthGuard('github'))
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  async githubCallback(@Req() req: Request, @Res() res: Response) {
    const profile = req.user as OAuthUserProfile;
    const { accessToken } = await this.oauthService.findOrCreate(profile);
    res.redirect(`${this.frontendUrl()}/auth/callback?token=${accessToken}`);
  }
}
