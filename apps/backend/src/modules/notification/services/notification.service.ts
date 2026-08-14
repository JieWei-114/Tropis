import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { NotificationGateway } from '../../websocket/gateways/notification.gateway';

export interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface SmsPayload {
  to: string; // E.164 format e.g. "+60123456789"
  body: string;
}

export interface PushPayload {
  userId: string;
  event: string;
  data: Record<string, unknown>;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private readonly mailer: nodemailer.Transporter;

  constructor(
    private readonly config: ConfigService,
    private readonly gateway: NotificationGateway,
  ) {
    this.mailer = nodemailer.createTransport({
      host: config.get('SMTP_HOST', 'localhost'),
      port: config.get<number>('SMTP_PORT', 1025),
      secure: false, // MailHog uses plain SMTP; set true for TLS in prod
      auth: config.get('SMTP_USER')
        ? { user: config.get('SMTP_USER'), pass: config.get('SMTP_PASS', '') }
        : undefined,
    });
  }

  async sendEmail(payload: EmailPayload): Promise<void> {
    try {
      const from = this.config.get('SMTP_FROM', 'noreply@tropis.local');
      await this.mailer.sendMail({ from, ...payload });
      this.logger.log(`Email sent to ${payload.to} — "${payload.subject}"`);
    } catch (err) {
      this.logger.error(
        `Failed to send email to ${payload.to}`,
        (err as Error).message,
      );
    }
  }

  async sendSms(payload: SmsPayload): Promise<void> {
    const provider = this.config.get('SMS_PROVIDER', 'stub');

    if (provider === 'twilio') {
      // Production: inject Twilio client and call messages.create(...)
      // Kept as a stub so the codebase compiles without the Twilio SDK.
      this.logger.warn(
        'Twilio SMS not configured — set SMS_PROVIDER=twilio and add credentials',
      );
      return;
    }

    // Stub: log the message so devs can see it without a real SMS gateway
    this.logger.log(`[SMS STUB] To: ${payload.to} | Body: ${payload.body}`);
  }

  async sendPush(payload: PushPayload): Promise<void> {
    this.gateway.sendToUser(payload.userId, payload.event, payload.data);
    this.logger.debug(
      `In-app push sent to user ${payload.userId} — event: ${payload.event}`,
    );
  }

  async sendAll(opts: {
    email?: EmailPayload;
    sms?: SmsPayload;
    push?: PushPayload;
  }): Promise<void> {
    const tasks: Promise<void>[] = [];
    if (opts.email) tasks.push(this.sendEmail(opts.email));
    if (opts.sms) tasks.push(this.sendSms(opts.sms));
    if (opts.push) tasks.push(this.sendPush(opts.push));
    await Promise.allSettled(tasks);
  }
}
