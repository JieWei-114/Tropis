import { ERROR_CATALOG, type ErrorCode } from './catalog';

export * from './catalog';
export * from './problem';

/** Every catalog code keyed by itself, e.g. `ERROR_CODES.USER_NOT_FOUND`. */
export const ERROR_CODES = Object.freeze(
  Object.fromEntries(Object.keys(ERROR_CATALOG).map((c) => [c, c])),
) as { readonly [K in ErrorCode]: K };
