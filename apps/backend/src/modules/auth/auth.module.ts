import { Global, Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { StringValue } from 'ms';
import { TOKEN_VERIFIER } from '../../common/auth/token-verifier.port';
import { CREDENTIAL_ATTEMPTS } from '../../common/auth/credential-attempts.port';
import { TokenVerifierService } from './services/token-verifier.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AuthService } from './services/auth.service';
import { LoginLockoutService } from './services/login-lockout.service';
import { SessionService } from './services/session.service';
import { OAuthService } from './services/oauth.service';
import { KvModule } from '../../infrastructure/kv/kv.module';
import { RateLimitModule } from '../../infrastructure/ratelimit/ratelimit.module';
import { TenantDirectoryModule } from '../tenant/tenant-directory.module';
import { UserModule } from '../user/user.module';

/**
 * Token verification and the auth services, without any transport. Global so
 * the RPC server, the HTTP guard and the WebSocket gateway reach
 * TOKEN_VERIFIER, and the user module reaches CREDENTIAL_ATTEMPTS without
 * importing auth. The endpoints are AuthApiModule.
 */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: config.getOrThrow<string>('JWT_EXPIRES_IN') as StringValue,
        },
      }),
    }),
    forwardRef(() => UserModule),
    KvModule.forRoot(),
    RateLimitModule.forRoot(),
    TenantDirectoryModule,
  ],
  providers: [
    TokenVerifierService,
    { provide: TOKEN_VERIFIER, useExisting: TokenVerifierService },
    JwtAuthGuard,
    AuthService,
    LoginLockoutService,
    { provide: CREDENTIAL_ATTEMPTS, useExisting: LoginLockoutService },
    SessionService,
    OAuthService,
  ],
  exports: [
    JwtModule,
    JwtAuthGuard,
    AuthService,
    LoginLockoutService,
    OAuthService,
    TOKEN_VERIFIER,
    CREDENTIAL_ATTEMPTS,
  ],
})
export class AuthModule {}
