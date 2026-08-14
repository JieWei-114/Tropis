import { registerAs } from '@nestjs/config';
import { DEFAULT_CORS_ORIGIN } from './cors.constants';

export const appConfig = registerAs('app', () => ({
  port: parseInt(process.env.PORT ?? '3100', 10),
  env: process.env.NODE_ENV ?? 'development',
  corsOrigin: process.env.CORS_ORIGIN ?? DEFAULT_CORS_ORIGIN,
  logLevel: process.env.LOG_LEVEL ?? 'info',
}));

export const dbConfig = registerAs('db', () => ({
  mongoUri: process.env.MONGODB_URI ?? 'mongodb://localhost:27017/tropis',
  redisHost: process.env.REDIS_HOST ?? 'localhost',
  redisPort: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  redisPass: process.env.REDIS_PASSWORD,
  chHost: process.env.CLICKHOUSE_HOST ?? 'http://localhost:8123',
  chUser: process.env.CLICKHOUSE_USER ?? 'default',
  chPassword: process.env.CLICKHOUSE_PASSWORD ?? '',
  chDatabase: process.env.CLICKHOUSE_DATABASE ?? 'logs',
}));

export const authConfig = registerAs('auth', () => ({
  // No fallback — env validation (Joi) guarantees this is set before startup
  jwtSecret: process.env.JWT_SECRET!,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
}));

export const messagingConfig = registerAs('messaging', () => ({
  pulsarUrl: process.env.PULSAR_SERVICE_URL ?? 'pulsar://localhost:6650',
  grpcUrl: process.env.GRPC_URL ?? 'localhost:5000',
}));
