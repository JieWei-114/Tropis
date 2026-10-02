import { LogMailAdapter } from '../adapters/log/log-mail.adapter';
import * as nodemailer from 'nodemailer';
import {
  SMTP_PROBE_CACHE_MS,
  SmtpMailAdapter,
} from '../adapters/smtp/smtp-mail.adapter';

describe('SmtpMailAdapter', () => {
  const transport = {
    sendMail: jest.fn().mockResolvedValue({}),
    verify: jest.fn(),
  };
  let clock = 0;
  let adapter: SmtpMailAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    clock = 0;
    adapter = new SmtpMailAdapter(
      { host: 'h', port: 1025, from: 'noreply@example.test' },
      transport as never,
      () => clock,
    );
  });

  it('bounds connection, greeting and socket time', () => {
    const create = jest
      .spyOn(nodemailer, 'createTransport')
      .mockReturnValue(transport as never);
    new SmtpMailAdapter({ host: 'h', port: 25, from: 'x@y.test' });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionTimeout: expect.any(Number) as unknown,
        greetingTimeout: expect.any(Number) as unknown,
        socketTimeout: expect.any(Number) as unknown,
      }),
    );
    create.mockRestore();
  });

  it('runs the SMTP handshake at most once per probe window', async () => {
    transport.verify.mockResolvedValue(true);
    await adapter.health();
    await adapter.health();
    expect(transport.verify).toHaveBeenCalledTimes(1);
    clock = SMTP_PROBE_CACHE_MS;
    await adapter.health();
    expect(transport.verify).toHaveBeenCalledTimes(2);
  });

  it('sends from the configured address', async () => {
    await adapter.send({ to: 'a@b.test', subject: 'Hi', html: '<p>x</p>' });
    expect(transport.sendMail).toHaveBeenCalledWith({
      from: 'noreply@example.test',
      to: 'a@b.test',
      subject: 'Hi',
      html: '<p>x</p>',
    });
  });

  it('rejects when the transport fails, leaving the policy to the caller', async () => {
    transport.sendMail.mockRejectedValueOnce(new Error('SMTP down'));
    await expect(
      adapter.send({ to: 'a@b.test', subject: 'Hi' }),
    ).rejects.toThrow('SMTP down');
  });

  it('reports health from an SMTP handshake', async () => {
    transport.verify.mockResolvedValueOnce(true);
    await expect(adapter.health()).resolves.toEqual({
      status: 'up',
      adapter: 'smtp',
    });
    clock = SMTP_PROBE_CACHE_MS;
    transport.verify.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(adapter.health()).resolves.toMatchObject({ status: 'down' });
  });
});

describe('single recipient', () => {
  const transport = { sendMail: jest.fn(), verify: jest.fn() };
  const smtp = new SmtpMailAdapter(
    { host: 'h', port: 1025, from: 'noreply@example.test' },
    transport as never,
  );
  const log = new LogMailAdapter();
  const invalid = [
    'a@b.test,c@d.test',
    'a@b.test;c@d.test',
    'Ada <a@b.test>',
    'a@b.test\r\nBcc: x@y.test',
    'not-an-address',
    `${'a'.repeat(250)}@b.test`,
    '',
  ];

  it.each(invalid)('rejects %j before anything is sent', async (to) => {
    for (const adapter of [smtp, log]) {
      await expect(adapter.send({ to, subject: 'x' })).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
    expect(transport.sendMail).not.toHaveBeenCalled();
  });
});

describe('LogMailAdapter', () => {
  it('accepts every message without a server and reports up', async () => {
    const adapter = new LogMailAdapter();
    await expect(
      adapter.send({ to: 'a@b.test', subject: 'Hi', text: 'x' }),
    ).resolves.toBeUndefined();
    await expect(adapter.health()).resolves.toEqual({
      status: 'up',
      adapter: 'log',
    });
  });
});
