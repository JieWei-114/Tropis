import { Catch, ArgumentsHost, HttpException } from '@nestjs/common';
import { BaseRpcExceptionFilter, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { Observable, throwError } from 'rxjs';
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
        const msg = (response as { message?: unknown }).message;
        message = Array.isArray(msg)
          ? (msg as string[]).join('; ')
          : msg
            ? String(msg)
            : exception.message;
      }
      return throwError(() => ({ code: grpcCode, message }));
    }

    const message =
      exception instanceof Error ? exception.message : 'Internal error';
    return throwError(() => ({ code: GrpcStatus.INTERNAL, message }));
  }
}
