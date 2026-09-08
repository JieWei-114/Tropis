import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';

// Module-level store so any code in the request call-chain can read the ID
// without passing it through every function argument.
const correlationStore = new AsyncLocalStorage<{ requestId: string }>();

export function getRequestId(): string {
  return correlationStore.getStore()?.requestId ?? 'no-request-context';
}

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const requestId =
      (req.headers['x-request-id'] as string | undefined) ?? randomUUID();

    res.setHeader('x-request-id', requestId);

    correlationStore.run({ requestId }, () => next());
  }
}
