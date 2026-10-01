import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { secretsLoaded } from '../secrets/secrets-env';

@Module({})
class NotSelected {}

/**
 * Imports `module` only when the `variable` adapter selector (read once the
 * secrets are loaded, never at import time) names `adapter`. Capability
 * modules use it for the driver connection behind one adapter, so a role
 * never opens a connection its configuration does not use.
 */
export async function importWhenSelected(
  variable: string,
  fallback: string,
  adapter: string,
  module: Type<unknown> | DynamicModule,
): Promise<DynamicModule> {
  await secretsLoaded();
  const selected = process.env[variable] || fallback;
  return selected === adapter ? asDynamic(module) : { module: NotSelected };
}

/** As importWhenSelected, for a connection several selectors share. */
export async function importWhenAnySelected(
  selectors: readonly { variable: string; fallback: string }[],
  adapter: string,
  module: Type<unknown> | DynamicModule,
): Promise<DynamicModule> {
  await secretsLoaded();
  const any = selectors.some(
    ({ variable, fallback }) => (process.env[variable] || fallback) === adapter,
  );
  return any ? asDynamic(module) : { module: NotSelected };
}

function asDynamic(module: Type<unknown> | DynamicModule): DynamicModule {
  return 'module' in module ? module : { module };
}
