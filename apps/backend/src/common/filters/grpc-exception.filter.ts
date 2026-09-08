import { Catch, ArgumentsHost, HttpException } from '@nestjs/common';
import { BaseRpcExceptionFilter, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { Observable } from 'rxjs';
import { HTTP_STATUS_TO_GRPC_STATUS } from '@tropis/shared';

@Catch()
export class GrpcExceptionFilter extends BaseRpcExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): Observable<never> {
    if (exception instanceof RpcException) {
      return super.catch(exception, host) as Observable<never>;
    }

    if (exception instanceof HttpException) {
      const httpStatus = exception.getStatus();
      const grpcCode =
        HTTP_STATUS_TO_GRPC_STATUS[httpStatus] ?? GrpcStatus.INTERNAL;
      const response = exception.getResponse();
      let message: string;
      if (typeof response === 'string') {
        message = response;
      } else {
        const res = response as { message?: unknown; code?: unknown };
        const msg = res.message;
        message = Array.isArray(msg)
          ? (msg as string[]).join('; ')
          : msg
            ? String(msg)
            : exception.message;
        // Carry a machine-readable code too when the thrower supplied one, so
        // the caller sees e.g. "USER_ALREADY_EXISTS: A user with this email…".
        if (typeof res.code === 'string') {
          message = `${res.code}: ${message}`;
        }
      }
      // Delegate through RpcException + super.catch — the path NestJS serializes
      // correctly to grpc-js. A raw throwError object surfaces to the client as
      // a generic UNKNOWN "Internal server error".
      return super.catch(
        new RpcException({ code: grpcCode, message }),
        host,
      ) as Observable<never>;
    }

    const message =
      exception instanceof Error ? exception.message : 'Internal error';
    return super.catch(
      new RpcException({ code: GrpcStatus.INTERNAL, message }),
      host,
    ) as Observable<never>;
  }
}
