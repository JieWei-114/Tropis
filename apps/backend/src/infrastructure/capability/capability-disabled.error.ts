/**
 * Thrown by every method of a `disabled` adapter. Selecting `disabled` is an
 * explicit configuration choice, so callers get a typed error they can catch
 * to degrade, instead of a connection error from a server that was never
 * meant to exist.
 */
export class CapabilityDisabledError extends Error {
  constructor(
    readonly capability: string,
    readonly operation?: string,
  ) {
    super(
      operation
        ? `Capability '${capability}' is disabled (called ${operation})`
        : `Capability '${capability}' is disabled`,
    );
    this.name = 'CapabilityDisabledError';
  }
}
