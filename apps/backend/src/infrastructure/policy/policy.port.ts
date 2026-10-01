import type { HealthCheckable } from '../capability';

/**
 * Policy — authorization decisions. allow() resolves only with a decision
 * the engine made; an unreachable or failing engine rejects with
 * SERVICE_UNAVAILABLE, so nothing is allowed (fail closed) and the caller
 * sees a retryable outage instead of a permission denial.
 */
export const POLICY = Symbol('POLICY');

export interface PolicyInput {
  roles: readonly string[];
  resource: string;
  action: string;
}

export interface PolicyPort extends HealthCheckable {
  allow(input: PolicyInput): Promise<boolean>;
}
