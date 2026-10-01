import * as nodemailer from 'nodemailer';
import { probeCapability, type CapabilityHealth } from '../../../capability';
import { assertSingleRecipient } from '../../mail-recipient';
import type { MailMessage, MailPort } from '../../mail.port';

export interface SmtpOptions {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from: string;
}

/** Bounds on each SMTP phase, so a hung server fails the send instead of holding it. */
export const SMTP_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 30_000,
} as const;

/** How long one SMTP handshake result answers health checks. */
export const SMTP_PROBE_CACHE_MS = 60_000;

/**
 * MailPort over SMTP (nodemailer). Plain SMTP (Mailpit locally; STARTTLS is
 * negotiated when the server offers it). health() runs an SMTP handshake
 * (EHLO, and AUTH when configured) at most once per SMTP_PROBE_CACHE_MS.
 */
export class SmtpMailAdapter implements MailPort {
  private readonly transport: nodemailer.Transporter;
  private probe: { at: number; result: Promise<CapabilityHealth> } | null =
    null;

  constructor(
    private readonly options: SmtpOptions,
    transport?: nodemailer.Transporter,
    private readonly now: () => number = Date.now,
  ) {
    this.transport =
      transport ??
      nodemailer.createTransport({
        host: options.host,
        port: options.port,
        secure: false,
        ...SMTP_TIMEOUTS,
        auth: options.user
          ? { user: options.user, pass: options.pass ?? '' }
          : undefined,
      });
  }

  async send(message: MailMessage): Promise<void> {
    assertSingleRecipient(message.to);
    await this.transport.sendMail({ from: this.options.from, ...message });
  }

  health(): Promise<CapabilityHealth> {
    const at = this.now();
    if (!this.probe || at - this.probe.at >= SMTP_PROBE_CACHE_MS) {
      this.probe = {
        at,
        result: probeCapability('smtp', () => this.transport.verify()),
      };
    }
    return this.probe.result;
  }
}
