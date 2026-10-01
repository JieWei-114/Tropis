import { Module } from '@nestjs/common';
import { NotificationGateway } from './gateways/notification.gateway';
import { RealtimeModule } from '../../infrastructure/realtime/realtime.module';
import { AuthModule } from '../auth/auth.module';

/**
 * Holds client sockets (public role only). Producers never inject the
 * gateway; they publish through REALTIME from any role.
 */
@Module({
  imports: [AuthModule, RealtimeModule.forRoot()],
  providers: [NotificationGateway],
})
export class WebsocketModule {}
