import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotificationService } from '../services/notification.service';
import { NotificationGateway } from '../../websocket/gateways/notification.gateway';
import * as nodemailer from 'nodemailer';

jest.mock('nodemailer');

describe('NotificationService', () => {
  let service: NotificationService;
  let mockGateway: jest.Mocked<Pick<NotificationGateway, 'sendToUser'>>;
  let mockTransporter: { sendMail: jest.Mock };

  beforeEach(async () => {
    mockTransporter = { sendMail: jest.fn().mockResolvedValue({}) };
    (nodemailer.createTransport as jest.Mock).mockReturnValue(mockTransporter);

    mockGateway = { sendToUser: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        NotificationService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string, def: unknown) => def) },
        },
        { provide: NotificationGateway, useValue: mockGateway },
      ],
    }).compile();

    service = module.get(NotificationService);
    jest.clearAllMocks();
  });

  it('sends email via nodemailer', async () => {
    await service.sendEmail({
      to: 'a@b.com',
      subject: 'Hello',
      html: '<p>Hi</p>',
    });
    expect(mockTransporter.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'a@b.com', subject: 'Hello' }),
    );
  });

  it('does not throw if email transport fails', async () => {
    mockTransporter.sendMail.mockRejectedValue(new Error('SMTP error'));
    await expect(
      service.sendEmail({ to: 'x@y.com', subject: 'Fail', html: '' }),
    ).resolves.not.toThrow();
  });

  it('logs SMS stub without throwing', async () => {
    await expect(
      service.sendSms({ to: '+60123456789', body: 'Test' }),
    ).resolves.not.toThrow();
  });

  it('sends in-app push via WebSocket gateway', async () => {
    await service.sendPush({ userId: 'u1', event: 'test', data: { x: 1 } });
    expect(mockGateway.sendToUser).toHaveBeenCalledWith('u1', 'test', { x: 1 });
  });

  it('sendAll calls all channels and does not throw on partial failure', async () => {
    mockTransporter.sendMail.mockRejectedValue(new Error('fail'));
    await expect(
      service.sendAll({
        email: { to: 'a@b.com', subject: 'S', html: '' },
        sms: { to: '+1', body: 'msg' },
        push: { userId: 'u2', event: 'ev', data: {} },
      }),
    ).resolves.not.toThrow();
    expect(mockGateway.sendToUser).toHaveBeenCalled();
  });
});
