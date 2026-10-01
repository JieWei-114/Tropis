import type { DescMessage } from '@bufbuild/protobuf';
import type { Type } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { FieldViolation } from '@tropis/shared';
import { fieldViolationsFromValidationErrors } from '../../common/errors';

/**
 * Field violations of a request message against its DTO, with the proto
 * field names (`page_token`, not `pageToken`) as AIP-193 BadRequest expects.
 */
export function rpcFieldViolations(
  schema: DescMessage | undefined,
  message: object,
  dto: Type<object>,
): FieldViolation[] {
  const plain: Record<string, unknown> = {};
  const protoName = new Map<string, string>();
  if (schema) {
    for (const field of schema.fields) {
      plain[field.localName] = (message as Record<string, unknown>)[
        field.localName
      ];
      protoName.set(field.localName, field.name);
    }
  } else {
    for (const [key, value] of Object.entries(message)) {
      if (!key.startsWith('$')) plain[key] = value;
    }
  }
  const instance = plainToInstance(dto, plain);
  const errors = validateSync(instance, { forbidUnknownValues: false });
  return fieldViolationsFromValidationErrors(errors).map((v) => {
    const [head, ...rest] = v.field.split('.');
    return {
      ...v,
      field: [protoName.get(head) ?? head, ...rest].join('.'),
      description: v.description.replace(
        new RegExp(`^${head}\\b`),
        protoName.get(head) ?? head,
      ),
    };
  });
}
