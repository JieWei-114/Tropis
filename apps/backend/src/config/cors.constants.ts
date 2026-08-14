/**
 * Default browser origin for CORS / OAuth redirects.
 * Keep in sync with `env.validation.ts` (`CORS_ORIGIN` Joi default).
 */
export const DEFAULT_CORS_ORIGIN = 'http://localhost:5173';

export function corsOriginFromEnv(): string {
  return process.env['CORS_ORIGIN'] ?? DEFAULT_CORS_ORIGIN;
}
