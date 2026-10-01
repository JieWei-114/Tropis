/**
 * Minimal circuit breaker — three states: CLOSED → OPEN → HALF_OPEN.
 *
 * CLOSED   : calls pass through normally; failures accumulate.
 * OPEN     : calls are rejected immediately (fail-fast) for `resetTimeoutMs`.
 * HALF_OPEN: exactly one probe call is let through; concurrent calls are rejected
 *            until it settles. Success closes the circuit, failure re-opens it.
 */

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening. Default 5. */
  failureThreshold?: number;
  /** Milliseconds the circuit stays open before a probe is allowed. Default 30_000. */
  resetTimeoutMs?: number;
  /** Human-readable name for logging. */
  name?: string;
  /** Clock, for tests. */
  now?: () => number;
}

export class CircuitBreakerOpenError extends Error {
  constructor(name: string) {
    super(`Circuit breaker [${name}] is OPEN — call rejected`);
    this.name = 'CircuitBreakerOpenError';
  }
}

type State = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
  private state: State = 'CLOSED';
  private failures = 0;
  private openedAt = 0;
  private probing = false;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly name: string;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 30_000;
    this.name = opts.name ?? 'unnamed';
    this.now = opts.now ?? Date.now;
  }

  async fire<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (this.now() - this.openedAt >= this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
      } else {
        throw new CircuitBreakerOpenError(this.name);
      }
    }

    const isProbe = this.state === 'HALF_OPEN';
    if (isProbe) {
      if (this.probing) throw new CircuitBreakerOpenError(this.name);
      this.probing = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    } finally {
      if (isProbe) this.probing = false;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = 'CLOSED';
  }

  private onFailure(): void {
    this.failures += 1;
    if (this.state === 'HALF_OPEN' || this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = this.now();
    }
  }

  get currentState(): State {
    return this.state;
  }
}
