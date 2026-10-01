import { SetMetadata, type Type } from '@nestjs/common';
import { ValidateIf, type ValidationOptions } from 'class-validator';

export const RPC_VALIDATE_KEY = 'rpc:validate';

/**
 * The class-validator DTO an RPC handler's request is checked against
 * before the handler runs (interceptors/validation.interceptor.ts). Every
 * handler whose request message has fields must declare one; the RpcServer
 * refuses to start otherwise. DTO properties use the generated field names
 * (`localName`, camelCase); violations report the proto field names.
 */
export const RpcValidate = (dto: Type<object>): MethodDecorator =>
  SetMetadata(RPC_VALIDATE_KEY, dto);

/**
 * proto3 has no "absent" for scalars: an omitted string is '' and an
 * omitted number 0. Marks a field whose zero value means "not set", so its
 * other rules apply only to a value the caller gave.
 */
export function ProtoOptional(options?: ValidationOptions): PropertyDecorator {
  return ValidateIf(
    (_obj, value: unknown) =>
      value !== '' && value !== 0 && value !== undefined && value !== null,
    options,
  );
}
