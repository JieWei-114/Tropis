import { toTenantId } from '../../../common/keyspace';
import { Test } from '@nestjs/testing';
import { NotificationService } from '../services/notification.service';
import {
  REALTIME,
  type RealtimePort,
} from '../../../infrastructure/realtime/realtime.port';
import { JOBS } from '../../../infrastructure/jobs/jobs.port';
import { MAIL } from '../../../infrastructure/mail/mail.port';
import {
  JOB_SEND_NOTIFICATION,
  QUEUE_NOTIFICATION,
} from '../constants/notification.constants';

describe('NotificationService', () => {
  let service: NotificationService;
  let realtime: jest.Mocked<Pick<RealtimePort, 'publishToUser'>>;
  let mail: { send: jest.Mock };
  let jobs: { enqueue: jest.Mock };

  beforeEach(async () => {
    mail = { send: jest.fn().mockResolvedValue(undefined) };
    jobs = { enqueue: jest.fn().mockResolvedValue({ id: 'j' }) };

    realtime = { publishToUser: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        NotificationService,
        { provide: JOBS, useValue: jobs },
        { provide: REALTIME, useValue: realtime },
        { provide: MAIL, useValue: mail },
      ],
    }).compile();

    service = module.get(NotificationService);
  });

  it('sends email through the mail port', async () => {
    await service.sendEmail({
      to: 'a@b.com',
      subject: 'Hello',
      html: '<p>Hi</p>',
    });
    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'a@b.com', subject: 'Hello' }),
    );
  });

  it('rejects when the mail port fails, so the job or activity is retried', async () => {
    mail.send.mockRejectedValue(new Error('SMTP error'));
    await expect(
      service.sendEmail({ to: 'x@y.com', subject: 'Fail', html: '' }),
    ).rejects.toThrow('SMTP error');
  });

  it('logs SMS stub without throwing', async () => {
    await expect(
      service.sendSms({ to: '+60123456789', body: 'Test' }),
    ).resolves.not.toThrow();
  });

  it('sends in-app push through the realtime port', async () => {
    await service.sendPush({
      tenantId: toTenantId('acme'),
      userId: 'u1',
      event: 'test',
      data: { x: 1 },
    });
    expect(realtime.publishToUser).toHaveBeenCalledWith('acme', 'u1', 'test', {
      x: 1,
    });
  });

  it('sendAll calls all channels and does not throw on partial failure', async () => {
    mail.send.mockRejectedValue(new Error('fail'));
    await expect(
      service.sendAll({
        email: { to: 'a@b.com', subject: 'S', html: '' },
        sms: { to: '+1', body: 'msg' },
        push: {
          tenantId: toTenantId('acme'),
          userId: 'u2',
          event: 'ev',
          data: {},
        },
      }),
    ).resolves.not.toThrow();
    expect(realtime.publishToUser).toHaveBeenCalled();
  });

  it('enqueues a notification job on its own queue, idempotent by job id', async () => {
    const job = {
      tenantId: 'acme',
      userId: 'u1',
      channel: 'email' as const,
      template: 'welcome',
      payload: {},
    };
    await service.enqueue(job, 'welcome-u1');
    expect(jobs.enqueue).toHaveBeenCalledWith(
      QUEUE_NOTIFICATION,
      JOB_SEND_NOTIFICATION,
      job,
      { jobId: 'welcome-u1' },
    );
  });
});
