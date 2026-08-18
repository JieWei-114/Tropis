import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import type { StringValue } from 'ms';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AuthService } from './services/auth.service';
import { LoginLockoutService } from './services/login-lockout.service';
import { OAuthService } from './services/oauth.service';
import { GoogleStrategy } from './strategies/google.strategy';
import { GithubStrategy } from './strategies/github.strategy';
import { AuthController } from './controllers/auth.controller';
import { UserModule } from '../user/user.module';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: config.get<string>('JWT_EXPIRES_IN', '15m') as StringValue,
        },
      }),
    }),
    forwardRef(() => UserModule), // circular: AuthModule ↔ UserModule
  ],
  controllers: [AuthController],
  providers: [
    JwtStrategy,
    JwtAuthGuard,
    AuthService,
    LoginLockoutService,
    OAuthService,
    GoogleStrategy,
    GithubStrategy,
  ],
  exports: [JwtModule, JwtAuthGuard, AuthService],
})
export class AuthModule {}
