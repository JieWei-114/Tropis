import { Module, Global } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditLogService } from './services/audit-log.service';
import { AuditInterceptor } from '../../common/interceptors/audit.interceptor';

/**
 * Security audit trail — registers the global AuditInterceptor which writes
 * an entry to ClickHouse logs.audit_log for every handler marked @Audited.
 * Global so AuditLogService is injectable anywhere without imports.
 */
@Global()
@Module({
  providers: [
    AuditLogService,
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [AuditLogService],
})
export class AuditModule {}
