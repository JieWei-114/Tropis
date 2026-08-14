import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { ERROR_CODES, HTTP_STATUS_TO_ERROR_CODE } from '@tropis/shared';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const traceId =
      (request.headers['x-trace-id'] as string | undefined) ?? randomUUID();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let code: string = ERROR_CODES.INTERNAL_ERROR;
    let errors: unknown[] | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();

      if (typeof body === 'object' && body !== null) {
        const b = body as Record<string, unknown>;
        message = Array.isArray(b.message)
          ? (b.message as string[]).join(', ')
          : String(b.message ?? message);
        code =
          typeof b.code === 'string'
            ? b.code
            : (HTTP_STATUS_TO_ERROR_CODE[status] ?? ERROR_CODES.HTTP_ERROR);
        errors = Array.isArray(b.message)
          ? (b.message as unknown[])
          : undefined;
      } else {
        message = String(body);
        code = HTTP_STATUS_TO_ERROR_CODE[status] ?? ERROR_CODES.HTTP_ERROR;
      }
    } else if (exception instanceof Error) {
      this.logger.error(
        `Unhandled exception [${traceId}]: ${exception.message}`,
        exception.stack,
      );
    }

    response.status(status).json({
      success: false,
      code,
      message,
      traceId,
      path: request.url,
      timestamp: new Date().toISOString(),
      ...(errors ? { errors } : {}),
    });
  }
}
