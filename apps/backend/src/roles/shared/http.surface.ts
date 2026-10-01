import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe, type Type } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import type { Server } from 'http';
import type { Duplex } from 'stream';
import { API_PREFIX } from '../../config/http.constants';
import { corsOriginFromEnv } from '../../config/cors.constants';
import { validationExceptionFactory } from '../../common/errors';
import type { Surface } from './bootstrap';

export function createHttpApp(
  root: Type<unknown>,
): Promise<NestExpressApplication> {
  return NestFactory.create<NestExpressApplication>(root, { bufferLogs: true });
}

/** The HTTP API on PORT: REST exceptions, Swagger (non-production) and /ws. */
export const httpSurface: Surface = async (context, listening) => {
  const app = context as NestExpressApplication;
  const config = app.get(ConfigService);
  const env = config.getOrThrow<string>('NODE_ENV');

  // Trust the first proxy hop so req.ips reflects X-Forwarded-For
  // (required by ThrottlerBehindProxyGuard for per-client rate limiting).
  app.set('trust proxy', 1);
  app.use(helmet());
  // Body limits against memory exhaustion. `verify` keeps the exact raw bytes
  // on req.rawBody for SignatureGuard, which signs the wire bytes.
  app.use(
    json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(urlencoded({ extended: true, limit: '1mb' }));
  // The same allow-list guards the public RPC listener. Credentials are on
  // for the refresh cookie, so the origin list is always explicit, never '*'.
  app.enableCors({
    origin: corsOriginFromEnv(),
    credentials: true,
    exposedHeaders: ['x-request-id', 'retry-after'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );
  app.setGlobalPrefix(API_PREFIX);
  // Docs only outside production, so the API shape is not handed to scanners.
  if (env !== 'production') {
    const doc = new DocumentBuilder()
      .setTitle('Tropis API')
      .setDescription('NestJS backend — REST + RPC + WebSockets')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup(
      'api/docs',
      app,
      SwaggerModule.createDocument(app, doc),
    );
  }

  const port = config.getOrThrow<number>('PORT');
  trackUpgrades(app.getHttpServer());
  await app.listen(port);
  listening.httpPort = port;
  listening.websocketPath = '/ws';
  listening.docsPath = env !== 'production' ? '/api/docs' : undefined;

  return () => stopAccepting(app.getHttpServer());
};

const upgraded = new WeakMap<Server, Set<Duplex>>();

/**
 * Records the sockets upgraded off `server` (the WebSocket connections), so
 * stopAccepting can end them: server.close() waits for every connection,
 * and an upgraded one never ends on its own. An upgrade nobody else handles
 * is refused.
 */
export function trackUpgrades(server: Server): void {
  if (upgraded.has(server)) return;
  const sockets = new Set<Duplex>();
  upgraded.set(server, sockets);
  server.on('upgrade', (_req, socket: Duplex) => {
    if (server.listenerCount('upgrade') === 1) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
}

/**
 * Stops accepting connections, ends idle keep-alive ones and the upgraded
 * (WebSocket) ones, whose clients reconnect elsewhere; resolves once
 * in-flight requests have finished (the caller bounds the wait).
 */
export function stopAccepting(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  for (const socket of upgraded.get(server) ?? []) socket.destroy();
  return closed;
}
