import type { DescMethod } from '@bufbuild/protobuf';
import {
  createContextValues,
  createHandlerContext,
  type HandlerContext,
} from '@connectrpc/connect';
import { Reflector } from '@nestjs/core';
import type { Type } from '@nestjs/common';
import type { AuthorizationService } from '../../../common/authz/authorization.service';
import { permissionOf } from '../../../common/authz/authorize.decorator';
import { HealthService } from '../../../gen/health/v1/health_pb';
import {
  callerOf,
  RPC_CREDENTIALS,
  type RpcAuthzService,
  type RpcCredentials,
} from '../rpc-authz.service';
import { AppError } from '../../../common/errors';
import { toConnectError } from '../rpc-errors';
import { RPC_VALIDATE_KEY } from '../rpc-validate.decorator';
import { rpcFieldViolations } from '../rpc-validation';

/**
 * A handler context as the RpcServer interceptors would hand it to a handler,
 * for calling an RPC controller method directly in a unit test. Credentials
 * are resolved by the real RpcAuthzService from the given headers.
 */
export async function rpcTestContext(
  authz: RpcAuthzService,
  headers: Record<string, string> = {},
  method: DescMethod = HealthService.method.check,
): Promise<HandlerContext> {
  return rpcContextFor(
    await authz.authenticate(new Headers(headers)),
    headers,
    method,
  );
}

/** A handler context carrying already-resolved credentials. */
export function rpcContextFor(
  credentials: RpcCredentials,
  headers: Record<string, string> = {},
  method: DescMethod = HealthService.method.check,
): HandlerContext {
  const requestHeader = new Headers(headers);
  const values = createContextValues();
  values.set(RPC_CREDENTIALS, credentials);
  return createHandlerContext({
    service: method.parent,
    method,
    protocolName: 'connect',
    requestMethod: 'POST',
    url: `/${method.parent.typeName}/${method.name}`,
    requestHeader,
    contextValues: values,
  });
}

/** `authorization: Bearer <token>` headers. */
export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

/** An RPC controller as the RpcServer calls it: every method takes (req, ctx). */
export type RpcCalls<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (req: A[0], ctx: HandlerContext) => R
    : T[K];
};

/**
 * Wraps a controller so each call first runs the @Authorize check and the
 * @RpcValidate check the RPC interceptors run, with the same errors, before
 * the method.
 */
export function withAuthorization<T extends object>(
  controller: T,
  authorization: AuthorizationService,
): RpcCalls<T> {
  const reflector = new Reflector();
  return new Proxy(controller, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      return async (req: unknown, ctx: HandlerContext) => {
        const permission = permissionOf(reflector, method, target.constructor);
        if (permission) {
          const caller = callerOf(ctx.values.get(RPC_CREDENTIALS));
          try {
            await authorization.assert(caller.roles, permission);
          } catch (err) {
            throw toConnectError(err);
          }
        }
        const dto = reflector.get<Type<object> | undefined>(
          RPC_VALIDATE_KEY,
          method,
        );
        if (dto) {
          const violations = rpcFieldViolations(undefined, req as object, dto);
          if (violations.length) {
            throw toConnectError(AppError.validation(violations));
          }
        }
        const result: unknown = method.call(target, req, ctx);
        return result;
      };
    },
  }) as unknown as RpcCalls<T>;
}
