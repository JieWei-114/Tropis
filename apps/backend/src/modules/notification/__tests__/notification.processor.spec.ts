import { Reflector } from '@nestjs/core';
import { JOB_HANDLER_METADATA } from '../../../infrastructure/jobs/job-handler.decorator';
import {
  JOB_SEND_NOTIFICATION,
  QUEUE_NOTIFICATION,
} from '../constants/notification.constants';
import { NotificationProcessor } from '../processors/notification.processor';
import type { NotificationService } from '../services/notification.service';

describe('NotificationProcessor', () => {
  const notifications = {
    sendEmail: jest.fn().mockResolvedValue(undefined),
    sendSms: jest.fn().mockResolvedValue(undefined),
    sendPush: jest.fn().mockResolvedValue(undefined),
  };
  const processor = new NotificationProcessor(
    notifications as unknown as NotificationService,
  );
  const job = (channel: string, payload: Record<string, unknown>) => ({
    id: '1',
    name: JOB_SEND_NOTIFICATION,
    attemptsMade: 0,
    data: {
      tenantId: 'acme',
      userId: 'u1',
      channel,
      template: 'welcome',
      payload,
    } as never,
  });

  beforeEach(() => jest.clearAllMocks());

  it('is the job handler of the notification queue', () => {
    expect(
      new Reflector().get(JOB_HANDLER_METADATA, NotificationProcessor),
    ).toBe(QUEUE_NOTIFICATION);
  });

  it('sends an email job through NotificationService', async () => {
    await processor.process(job('email', { to: 'a@b.test', subject: 'Hi' }));
    expect(notifications.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'a@b.test', subject: 'Hi' }),
    );
  });

  it('routes sms and in-app jobs to their channels', async () => {
    await processor.process(job('sms', { to: '+1' }));
    await processor.process(job('in-app', { x: 1 }));
    expect(notifications.sendSms).toHaveBeenCalled();
    expect(notifications.sendPush).toHaveBeenCalledWith({
      tenantId: 'acme',
      userId: 'u1',
      event: 'welcome',
      data: { x: 1 },
    });
  });

  it('fails the attempt when sending throws, so the job is retried', async () => {
    notifications.sendSms.mockRejectedValueOnce(new Error('down'));
    await expect(processor.process(job('sms', { to: '+1' }))).rejects.toThrow(
      'down',
    );
  });

  it('fails an email job to more than one address permanently, sending nothing', async () => {
    await expect(
      processor.process(job('email', { to: 'a@b.test, c@d.test' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(notifications.sendEmail).not.toHaveBeenCalled();
  });
});
