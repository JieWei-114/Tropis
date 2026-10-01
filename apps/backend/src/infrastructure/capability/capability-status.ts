/**
 * Status every capability adapter reports about its backing system.
 *   up       — reachable and answering
 *   down     — configured but failing
 *   disabled — deliberately turned off by configuration (not a failure)
 */
export type CapabilityStatus = 'up' | 'down' | 'disabled';

export interface CapabilityHealth {
  status: CapabilityStatus;
  /** Adapter name, e.g. `redis`, `neo4j`, `disabled`. */
  adapter: string;
  /** Failure reason when `down`. */
  message?: string;
}

/** Implemented by every adapter so one health indicator shape fits all capabilities. */
export interface HealthCheckable {
  health(): Promise<CapabilityHealth>;
}

export function capabilityUp(adapter: string): CapabilityHealth {
  return { status: 'up', adapter };
}

export function capabilityDisabled(): CapabilityHealth {
  return { status: 'disabled', adapter: 'disabled' };
}

export function capabilityDown(
  adapter: string,
  err: unknown,
): CapabilityHealth {
  return { status: 'down', adapter, message: describeError(err) };
}

/**
 * A readable reason. Connection failures often surface as an AggregateError
 * with an empty message, so fall back to its code or name.
 */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.message) return err.message;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : err.name;
}

/** Runs a probe and maps its outcome to up/down. */
export async function probeCapability(
  adapter: string,
  probe: () => Promise<unknown>,
): Promise<CapabilityHealth> {
  try {
    await probe();
    return capabilityUp(adapter);
  } catch (err) {
    return capabilityDown(adapter, err);
  }
}
