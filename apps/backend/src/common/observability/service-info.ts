/**
 * Identity of this process, shared by the trace resource (tracing.ts) and
 * every log record, so logs and spans from one process are joinable on the
 * same `service.*` attributes.
 */
export interface ServiceInfo {
  name: string;
  version: string;
  environment: string;
  /**
   * Which role this process runs (all, public, private, worker, scheduler),
   * set by its entry point (src/roles/<role>/role.ts).
   */
  role: string;
}

export function serviceInfo(env: NodeJS.ProcessEnv = process.env): ServiceInfo {
  return {
    name: env.OTEL_SERVICE_NAME || 'tropis-backend',
    version: env.SERVICE_VERSION || env.npm_package_version || '0.0.1',
    environment: env.NODE_ENV || 'development',
    role: env.SERVICE_ROLE || 'all',
  };
}
