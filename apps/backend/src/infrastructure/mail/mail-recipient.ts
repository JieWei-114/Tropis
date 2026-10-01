import { isEmail } from 'class-validator';
import { AppError } from '../../common/errors/app-error';

/** Longest address SMTP carries (RFC 5321 path limit). */
export const MAX_RECIPIENT_LENGTH = 254;

/**
 * Throws VALIDATION_FAILED (never retried) unless `to` is exactly one bare
 * address: no list separators, no display name, no line breaks. Every mail
 * adapter checks it, so no caller can turn a message into a relay.
 */
export function assertSingleRecipient(to: unknown): asserts to is string {
  const ok =
    typeof to === 'string' &&
    to.length > 0 &&
    to.length <= MAX_RECIPIENT_LENGTH &&
    !/[,;<>\r\n\s"]/.test(to) &&
    isEmail(to);
  if (!ok) {
    throw AppError.validation([
      { field: 'to', description: 'must be a single email address' },
    ]);
  }
}
