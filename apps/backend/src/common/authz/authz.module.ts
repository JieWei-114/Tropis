import { Module } from '@nestjs/common';
import { PolicyModule } from '../../infrastructure/policy/policy.module';
import { AuthorizationService } from './authorization.service';
import { AuthorizeGuard } from './authorize.guard';

/** @Authorize enforcement: the policy decision and the HTTP guard. */
@Module({
  imports: [PolicyModule.forRoot()],
  providers: [AuthorizationService, AuthorizeGuard],
  exports: [AuthorizationService, AuthorizeGuard],
})
export class AuthzModule {}
