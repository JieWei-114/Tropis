import { Module, Global } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { NotificationGateway } from './gateways/notification.gateway';
import { AuthModule } from '../auth/auth.module';

@Global()
@Module({
  imports: [
    AuthModule, // for AuthService — token blacklist checks on WS connect
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  providers: [NotificationGateway],
  exports: [NotificationGateway],
})
export class WebsocketModule {}
