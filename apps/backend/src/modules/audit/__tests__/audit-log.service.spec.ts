import { Test, TestingModule } from '@nestjs/testing';
import { AuditLogService } from '../services/audit-log.service';
import { CLICKHOUSE_CLIENT } from '../../../infrastructure/clickhouse/clickhouse.module';
import { AUDIT_LOG_TABLE, AUDIT_OUTCOME } from '../constants';
import { IAuditEntry } from '../interfaces';

describe('AuditLogService', () => {
  let service: AuditLogService;
  let ch: { insert: jest.Mock };

  const entry: IAuditEntry = {
    action: 'user.update',
    actorUserId: 'user-1',
    tenantId: 'acme',
    resource: 'GrpcUserService.update',
    transport: 'rpc',
    outcome: AUDIT_OUTCOME.SUCCESS,
    traceId: 'trace-1',
    timestamp: new Date('2026-01-01T00:00:00Z'),
  };

  beforeEach(async () => {
    ch = { insert: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditLogService,
        { provide: CLICKHOUSE_CLIENT, useValue: ch },
      ],
    }).compile();

    service = module.get(AuditLogService);
  });

  it('inserts a snake_case row into logs.audit_log', () => {
    service.record(entry);

    expect(ch.insert).toHaveBeenCalledWith({
      table: AUDIT_LOG_TABLE,
      values: [
        expect.objectContaining({
          action: 'user.update',
          actor_user_id: 'user-1',
          tenant_id: 'acme',
          resource: 'GrpcUserService.update',
          transport: 'rpc',
          outcome: 'success',
          error: '',
          trace_id: 'trace-1',
          timestamp: entry.timestamp.getTime(),
        }),
      ],
      format: 'JSONEachRow',
    });
  });

  it('never throws when ClickHouse is down (fire-and-forget)', async () => {
    ch.insert.mockRejectedValue(new Error('ch down'));

    expect(() => service.record(entry)).not.toThrow();
    // let the rejected promise settle — the catch handler must swallow it
    await new Promise((r) => setImmediate(r));
  });

  it('serialises the error field when present', () => {
    service.record({ ...entry, outcome: AUDIT_OUTCOME.ERROR, error: 'boom' });

    expect(ch.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        values: [expect.objectContaining({ outcome: 'error', error: 'boom' })],
      }),
    );
  });
});
