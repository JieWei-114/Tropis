/**
 * Reads a `<CAPABILITY>_ADAPTER` selector and checks it against the adapters
 * the module can build. Env validation already restricts the value; this
 * guards direct module use (tests, scripts) that bypasses validation.
 */
export function selectAdapter<T extends string>(
  variable: string,
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  const selected = (value ?? fallback) as T;
  if (!allowed.includes(selected)) {
    throw new Error(
      `Unsupported ${variable}=${selected}; expected one of ${allowed.join(', ')}`,
    );
  }
  return selected;
}
