import './env-bootstrap'; // load `.env` before decorators read `process.env`
import './tracing'; // starts OpenTelemetry before anything else
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { join } from 'path';
import { AppModule } from './app.module';
import { corsOriginFromEnv } from './config/cors.constants';
import {
  addGrpcReflection,
  grpcReflectionEnabled,
} from './config/grpc-reflection';
import { closePulsarClient } from './infrastructure/pulsar/pulsar.module';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';

// Proto contracts live at the repo root (proto/). At runtime __dirname is
// apps/backend/dist, so the repo root is three levels up (same layout in the
// Docker image: /app/apps/backend/dist -> /app/proto).
const PROTO_ROOT =
  process.env.PROTO_ROOT ?? join(__dirname, '..', '..', '..', 'proto');

async function bootstrap() {
  // Prometheus scrapes /api/metrics every 15s — each scrape adds a ServerResponse
  // listener. Default cap is 10, so raise it to avoid the MaxListeners warning.
  require('events').EventEmitter.defaultMaxListeners = 20;

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  // Trust the first proxy hop so req.ips reflects X-Forwarded-For
  // (required by ThrottlerBehindProxyGuard for correct per-client rate limiting)
  app.set('trust proxy', 1);

  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT', 3100);
  const grpcPort = config.get<number>('GRPC_PORT', 50051);
  const grpcInternalPort = config.get<number>('GRPC_INTERNAL_PORT', 50061);
  const env = config.get<string>('NODE_ENV', 'development');
  // gRPC server reflection (grpcurl/grpcui discovery) — dev-only by default,
  // opt-in via GRPC_REFLECTION=true elsewhere. See config/grpc-reflection.ts
  // for the gating rationale (applies to both listeners).
  const reflection = grpcReflectionEnabled(
    env,
    config.get<boolean>('GRPC_REFLECTION', false),
  );
  const onLoadPackageDefinition = reflection ? addGrpcReflection : undefined;

  // ── Security headers ─────────────────────────────────────────────
  app.use(helmet());

  // ── Body size limits ──────────────────────────────────────────────
  // Cap request bodies to prevent memory-exhaustion via oversized payloads.
  // The `verify` callback captures the exact raw bytes on req.rawBody —
  // required by SignatureGuard (HMAC is computed over the wire bytes, not a
  // re-serialised JSON round-trip). See docs/api-conventions.md.
  app.use(
    json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(urlencoded({ extended: true, limit: '1mb' }));

  // ── CORS ─────────────────────────────────────────────────────────
  app.enableCors({
    origin: corsOriginFromEnv(),
    credentials: true,
  });

  // ── Global exception filter ───────────────────────────────────────
  // Returns { success, code, message, traceId, path, timestamp } on all errors
  app.useGlobalFilters(new GlobalExceptionFilter());

  // ── Global validation ─────────────────────────────────────────────
  // whitelist: strip properties not in the DTO
  // forbidNonWhitelisted: throw 400 instead of silently stripping
  // transform: auto-cast query params to their DTO types (string → number etc.)
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // ── Global prefix ─────────────────────────────────────────────────
  app.setGlobalPrefix('api');

  // ── Swagger ───────────────────────────────────────────────────────
  // Only expose docs outside production — avoids leaking API shape to scanners
  if (env !== 'production') {
    const doc = new DocumentBuilder()
      .setTitle('Tropis API')
      .setDescription('NestJS backend — REST + gRPC + WebSockets')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup(
      'api/docs',
      app,
      SwaggerModule.createDocument(app, doc),
    );
  }

  // ── gRPC microservices — port-level tier separation ───────────────
  //
  // Security model: which tier an RPC belongs to is decided by which PORT
  // its package is loaded on, not by path/metadata filtering on a shared
  // listener. Envoy and the ingress only ever point at :50051 (public);
  // the internal tier on :50061 is exposed via a separate ClusterIP-only
  // Service (backend-internal-svc), restricted by NetworkPolicy to pods
  // within the namespace, AND still requires the x-service-token service
  // identity (zero-trust — belt and braces, see docs/api-conventions.md).
  //
  // NestJS routing note: @GrpcMethod handlers are matched by service name
  // across ALL connected gRPC microservices — a handler is only reachable
  // on a listener whose `package` list includes its proto package. The
  // internal package is loaded ONLY on the :50061 listener below, so the
  // internal controller is unreachable via :50051 even though controllers
  // are registered app-wide.

  // PUBLIC listener — exposed through Envoy (gRPC-Web) / cluster peers.
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      url: `0.0.0.0:${grpcPort}`,
      package: [
        'tropis.auth.v1',
        'tropis.user.v1',
        'tropis.analytics.v1',
        'tropis.tracking.v1',
        'tropis.health.v1',
      ],
      protoPath: [
        join(PROTO_ROOT, 'auth', 'v1', 'auth.proto'),
        join(PROTO_ROOT, 'user', 'v1', 'user.proto'),
        join(PROTO_ROOT, 'analytics', 'v1', 'analytics.proto'),
        join(PROTO_ROOT, 'tracking', 'v1', 'tracking.proto'),
        join(PROTO_ROOT, 'health', 'v1', 'health.proto'),
      ],
      loader: {
        keepCase: true, // preserve snake_case field names (access_token, login_count, etc.)
      },
      onLoadPackageDefinition,
    },
  });

  // INTERNAL listener — ClusterIP-only in production, never behind Envoy.
  // Also loads tropis.health.v1 so gRPC health probes work against this port
  // (the health handler carries no sensitive data, and probing :50061
  // directly verifies the internal listener itself is actually up).
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      url: `0.0.0.0:${grpcInternalPort}`,
      package: ['tropis.user.internal.v1', 'tropis.health.v1'],
      protoPath: [
        join(PROTO_ROOT, 'user', 'internal', 'v1', 'user_internal.proto'),
        join(PROTO_ROOT, 'health', 'v1', 'health.proto'),
      ],
      loader: {
        keepCase: true,
      },
      onLoadPackageDefinition,
    },
  });

  // ── Graceful shutdown ─────────────────────────────────────────────
  app.enableShutdownHooks();
  process.on('SIGTERM', async () => {
    await closePulsarClient();
  });

  await app.startAllMicroservices();
  await app.listen(port);

  console.log(`HTTP  → http://localhost:${port}/api`);
  if (env !== 'production') {
    console.log(`Docs  → http://localhost:${port}/api/docs`);
  }
  console.log(
    `gRPC  → localhost:${grpcPort} (public tier)${reflection ? ' [reflection on]' : ''}`,
  );
  console.log(`gRPC  → localhost:${grpcInternalPort} (internal tier)`);
  console.log(`WS    → ws://localhost:${port}/ws`);
}

void bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
