import type { ValidationError } from 'class-validator';
import type { FieldViolation } from '@tropis/shared';
import { AppError } from './app-error';

/**
 * Flattens class-validator's error tree into one violation per failed
 * constraint, with dotted paths for nested objects (`address.city`) and
 * indexes for arrays (`items.0.sku`).
 */
export function fieldViolationsFromValidationErrors(
  errors: readonly ValidationError[],
  parent = '',
): FieldViolation[] {
  const out: FieldViolation[] = [];
  for (const e of errors) {
    const field = parent ? `${parent}.${e.property}` : e.property;
    for (const description of Object.values(e.constraints ?? {})) {
      out.push({ field, description });
    }
    if (e.children?.length) {
      out.push(...fieldViolationsFromValidationErrors(e.children, field));
    }
  }
  return out;
}

const WHITELIST = /^property (\S+) should not exist$/;
const LEADING_FIELD = /^([A-Za-z_$][\w$]*(?:\.[\w$]+)*) /;

/**
 * Best-effort violations from the flat message list ValidationPipe produces
 * by default (`["email must be an email", "property x should not exist"]`).
 * class-validator's default messages start with the property path, so the
 * leading token is taken as the field.
 */
export function fieldViolationsFromMessages(
  messages: readonly unknown[],
): FieldViolation[] {
  return messages.map((m) => {
    const description = String(m);
    const whitelist = WHITELIST.exec(description);
    if (whitelist) return { field: whitelist[1], description };
    const lead = LEADING_FIELD.exec(description);
    return { field: lead ? lead[1] : '', description };
  });
}

/**
 * `exceptionFactory` for Nest's ValidationPipe: validation failures become
 * AppError VALIDATION_FAILED with exact field paths.
 */
export function validationExceptionFactory(
  errors: ValidationError[],
): AppError {
  return AppError.validation(fieldViolationsFromValidationErrors(errors));
}
