import type { HealthCheckable } from '../capability';

/**
 * Mail — outbound email. send() resolves once the message is accepted for
 * delivery and rejects on failure; whether a failure is fatal is the
 * caller's decision. `to` must be one bare address (assertSingleRecipient,
 * enforced by every adapter); anything else rejects with VALIDATION_FAILED.
 */
export const MAIL = Symbol('MAIL');

export interface MailMessage {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

export interface MailPort extends HealthCheckable {
  send(message: MailMessage): Promise<void>;
}

export const MAIL_ADAPTERS = ['smtp', 'log'] as const;
export type MailAdapterName = (typeof MAIL_ADAPTERS)[number];
