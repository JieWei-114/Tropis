import { Module } from '@nestjs/common';
import { OlapModule } from '../../infrastructure/olap/olap.module';
import { AuditLogService } from './audit-log.service';
import { AuditInterceptor } from './audit.interceptor';

/**
 * The security audit trail: AuditLogService writes logs.audit_log through
 * the OLAP capability. The RPC server records every @Audited call; a role
 * with an HTTP surface registers AuditInterceptor as an APP_INTERCEPTOR.
 */
@Module({
  imports: [OlapModule.forRoot()],
  providers: [AuditLogService, AuditInterceptor],
  exports: [AuditLogService, AuditInterceptor],
})
export class AuditModule {}
