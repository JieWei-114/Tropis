import { Test, TestingModule } from '@nestjs/testing';
import { AuditLogService } from '../audit-log.service';
import { OLAP } from '../../../infrastructure/olap/olap.port';
import { AUDIT_LOG_TABLE, AUDIT_OUTCOME } from '../audit.constants';
import { IAuditEntry } from '../audit.interface';
import { toTenantId } from '../../keyspace';

describe('AuditLogService', () => {
  let service: AuditLogService;
  let ch: { insert: jest.Mock; insertGlobal: jest.Mock };

  const entry: IAuditEntry = {
    action: 'user.update',
    actorUserId: 'user-1',
    tenantId: toTenantId('acme'),
    resource: 'GrpcUserService.update',
    transport: 'rpc',
    outcome: AUDIT_OUTCOME.SUCCESS,
    traceId: 'trace-1',
    timestamp: new Date('2026-01-01T00:00:00Z'),
  };

  beforeEach(async () => {
    ch = {
      insert: jest.fn().mockResolvedValue(undefined),
      insertGlobal: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [AuditLogService, { provide: OLAP, useValue: ch }],
    }).compile();

    service = module.get(AuditLogService);
  });

  it('inserts a snake_case row into logs.audit_log for the tenant', () => {
    service.record(entry);

    expect(ch.insert).toHaveBeenCalledWith('acme', AUDIT_LOG_TABLE, [
      expect.objectContaining({
        action: 'user.update',
        actor_user_id: 'user-1',
        resource: 'GrpcUserService.update',
        transport: 'rpc',
        outcome: 'success',
        error: '',
        trace_id: 'trace-1',
        timestamp: entry.timestamp.getTime(),
      }),
    ]);
  });

  it('never throws when the OLAP store is down (fire-and-forget)', async () => {
    ch.insert.mockRejectedValue(new Error('ch down'));

    expect(() => service.record(entry)).not.toThrow();
    // let the rejected promise settle — the catch handler must swallow it
    await new Promise((r) => setImmediate(r));
  });

  it('serialises the error field when present', () => {
    service.record({ ...entry, outcome: AUDIT_OUTCOME.ERROR, error: 'boom' });

    expect(ch.insert).toHaveBeenCalledWith('acme', AUDIT_LOG_TABLE, [
      expect.objectContaining({ outcome: 'error', error: 'boom' }),
    ]);
  });

  it('writes an entry without a tenant as a platform-scope row', () => {
    service.record({ ...entry, tenantId: undefined });

    expect(ch.insert).not.toHaveBeenCalled();
    expect(ch.insertGlobal).toHaveBeenCalledWith(AUDIT_LOG_TABLE, [
      expect.objectContaining({ tenant_id: '', action: 'user.update' }),
    ]);
  });
});
