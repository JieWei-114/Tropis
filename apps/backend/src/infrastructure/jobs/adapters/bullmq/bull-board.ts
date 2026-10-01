import {
  Inject,
  Injectable,
  type DynamicModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import { BullBoardModule, InjectBullBoard } from '@bull-board/nestjs';
import type { BullBoardInstance } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { JOB_QUEUES, type JobQueueRegistry } from '../../jobs.registry';
import { bullmqConnection } from './bullmq-options';
import { BullmqQueues } from './bullmq-queues';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Admits only a request made directly from this machine: a loopback socket
 * address and no forwarding header (a proxy in front, even a local one,
 * would make every client look local).
 */
export function loopbackOnly(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const direct =
    LOOPBACK.has(req.socket?.remoteAddress ?? '') &&
    !req.headers['x-forwarded-for'] &&
    !req.headers['x-real-ip'] &&
    !req.headers.forwarded;
  if (direct) {
    next();
    return;
  }
  res.status(404).end();
}

/** Adds every queue of the process to the board once all are declared. */
@Injectable()
export class BullBoardQueues
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly queues: BullmqQueues;

  constructor(
    @InjectBullBoard() private readonly board: BullBoardInstance,
    @Inject(JOB_QUEUES) private readonly registry: JobQueueRegistry,
    config: ConfigService,
  ) {
    this.queues = new BullmqQueues(bullmqConnection(config));
  }

  onApplicationBootstrap(): void {
    for (const name of this.registry.names()) {
      this.board.addQueue(new BullMQAdapter(this.queues.get(name)));
    }
  }

  onApplicationShutdown(): Promise<void> {
    return this.queues.close();
  }
}

/**
 * Bull Board is Express middleware mounted outside the global JWT guard, and
 * a browser dashboard cannot send a bearer token, so it is a developer tool
 * only: mounted in the `all` role (the local single-process backend) outside
 * production, and answering only requests from localhost. Deployed roles
 * never serve it.
 */
export function bullBoardEnabled(
  nodeEnv: string | undefined,
  role: string | undefined,
): boolean {
  return nodeEnv !== 'production' && (role ?? 'all') === 'all';
}

export function bullBoardImports(enabled: boolean): DynamicModule[] {
  if (!enabled) return [];
  return [
    BullBoardModule.forRoot({
      route: '/queues',
      adapter: ExpressAdapter,
      middleware: loopbackOnly,
    }),
  ];
}

export function bullBoardProviders(enabled: boolean): Provider[] {
  return enabled ? [BullBoardQueues] : [];
}
