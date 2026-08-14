import { SetMetadata } from '@nestjs/common';

export const AUDITED_KEY = 'audited';

/**
 * Marks a mutating handler (HTTP route or gRPC method) for audit logging.
 * The AuditInterceptor picks up the action name and writes an entry to
 * ClickHouse `logs.audit_log` on every invocation (success or error).
 *
 * @example
 *   @Audited('user.update')
 *   @GrpcMethod('UserService', 'Update')
 *   async update(...) { ... }
 */
export const Audited = (action: string): MethodDecorator & ClassDecorator =>
  SetMetadata(AUDITED_KEY, action);
