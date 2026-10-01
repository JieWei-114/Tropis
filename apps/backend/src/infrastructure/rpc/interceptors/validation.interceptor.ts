import type { DescMethod } from '@bufbuild/protobuf';
import type { Interceptor } from '@connectrpc/connect';
import type { Type } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { rpcFieldViolations } from '../rpc-validation';

/**
 * Checks each unary request against the DTO its handler declared with
 * @RpcValidate and rejects an invalid one with VALIDATION_FAILED and a
 * google.rpc.BadRequest field violation per failed rule, before the handler
 * runs. Innermost in the chain, after authentication and authorization, so
 * an anonymous caller learns nothing about a protected method's input.
 */
export function validationInterceptor(
  dtoOf: (method: DescMethod) => Type<object> | undefined,
): Interceptor {
  return (next) => async (req) => {
    const dto = dtoOf(req.method);
    if (dto && !req.stream) {
      const violations = rpcFieldViolations(req.method.input, req.message, dto);
      if (violations.length) throw AppError.validation(violations);
    }
    return next(req);
  };
}
