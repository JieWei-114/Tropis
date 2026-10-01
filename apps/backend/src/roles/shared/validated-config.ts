import type { DynamicModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envValidationSchema } from '../../config/env.validation';
import { secretsLoaded } from '../../infrastructure/secrets/secrets-env';

/**
 * The global, validated ConfigModule. ConfigModule.forRoot validates the
 * environment as soon as it is called, so the Vault KV secrets are merged
 * into process.env first: that way Vault can supply any key the schema
 * declares, and only a key missing from both falls back to its default.
 */
export async function validatedConfigModule(
  preload: () => Promise<unknown> = secretsLoaded,
): Promise<DynamicModule> {
  await preload();
  return ConfigModule.forRoot({
    isGlobal: true,
    envFilePath: '.env',
    validationSchema: envValidationSchema,
    validationOptions: {
      allowUnknown: true,
      abortEarly: false,
    },
  });
}
