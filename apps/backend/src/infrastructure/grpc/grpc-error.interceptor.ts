import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { toRpcException } from './grpc.utils';

/**
 * Normalizes errors for every inbound gRPC call.
 *
 * NestJS serializes RpcException natively, but any other error (e.g. a domain
 * ConflictException raised by a CQRS handler) reaches the client as a generic
 * UNKNOWN "Internal server error". This interceptor converts everything to an
 * RpcException with the right status code and message, so callers — and the
 * console UI — can actually tell what went wrong.
 */
@Injectable()
export class GrpcErrorInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'rpc') return next.handle();
    return next
      .handle()
      .pipe(
        catchError((err: unknown) => throwError(() => toRpcException(err))),
      );
  }
}
