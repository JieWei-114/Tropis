import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { RpcModule } from '../../infrastructure/rpc/rpc.module';
import { AuthModule } from './auth.module';
import { OAuthConfiguredGuard } from './guards/oauth-configured.guard';
import { GoogleStrategy } from './strategies/google.strategy';
import { GithubStrategy } from './strategies/github.strategy';
import { AuthController } from './controllers/auth.controller';
import { AuthRpcController } from './controllers/auth.rpc.controller';

/** REST /api/auth/* (incl. the OAuth redirects) and the public AuthService RPC. */
@Module({
  imports: [AuthModule, PassportModule, RpcModule.forRoot()],
  controllers: [AuthController],
  providers: [
    GoogleStrategy,
    GithubStrategy,
    OAuthConfiguredGuard,
    AuthRpcController,
  ],
})
export class AuthApiModule {}
