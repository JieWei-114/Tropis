/**
 * Environment validation for the Temporal worker.
 *
 * All variables have dev-stack defaults (docker-compose ports), so a plain
 * `pnpm start:dev` works with `make up`. Validation fails fast at boot with
 * a readable message instead of a cryptic runtime error inside an activity.
 */

export interface WorkerEnv {
  temporalAddress: string;
  temporalNamespace: string;
  taskQueue: string;
  smtpHost: string;
  smtpPort: number;
  smtpFrom: string;
  pgHost: string;
  pgPort: number;
  pgUser: string;
  pgPassword: string;
  pgDatabase: string;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`Invalid ${name}="${raw}" — expected a port number (1-65535)`);
  }
  return n;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

export function loadEnv(): WorkerEnv {
  return {
    temporalAddress: str('TEMPORAL_ADDRESS', 'localhost:7233'),
    temporalNamespace: str('TEMPORAL_NAMESPACE', 'default'),
    taskQueue: str('TEMPORAL_TASK_QUEUE', 'main'),
    // MailHog dev SMTP trap (docker-compose service `mailhog`)
    smtpHost: str('SMTP_HOST', 'localhost'),
    smtpPort: int('SMTP_PORT', 1025),
    smtpFrom: str('SMTP_FROM', 'noreply@tropis.local'),
    // App Postgres (docker-compose service `postgres`)
    pgHost: str('POSTGRES_HOST', 'localhost'),
    pgPort: int('POSTGRES_PORT', 5432),
    pgUser: str('POSTGRES_USER', 'tropis'),
    pgPassword: str('POSTGRES_PASSWORD', 'tropis_dev_password'),
    pgDatabase: str('POSTGRES_DB', 'tropis'),
  };
}
