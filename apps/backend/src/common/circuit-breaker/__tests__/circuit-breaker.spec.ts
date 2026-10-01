import { CircuitBreaker, CircuitBreakerOpenError } from '../circuit-breaker';

describe('CircuitBreaker', () => {
  const fail = () => Promise.reject(new Error('down'));

  it('opens after the failure threshold and rejects without calling', async () => {
    let now = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 1000,
      now: () => now,
    });
    await expect(breaker.fire(fail)).rejects.toThrow('down');
    await expect(breaker.fire(fail)).rejects.toThrow('down');
    const fn = jest.fn().mockResolvedValue(1);
    await expect(breaker.fire(fn)).rejects.toBeInstanceOf(
      CircuitBreakerOpenError,
    );
    expect(fn).not.toHaveBeenCalled();
    now = 999;
    await expect(breaker.fire(fn)).rejects.toBeInstanceOf(
      CircuitBreakerOpenError,
    );
  });

  it('lets exactly one probe through when half-open', async () => {
    let now = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      now: () => now,
    });
    await expect(breaker.fire(fail)).rejects.toThrow('down');
    now = 1000;

    let release!: (v: number) => void;
    const probe = jest.fn(
      () => new Promise<number>((resolve) => (release = resolve)),
    );
    const first = breaker.fire(probe);
    const second = breaker.fire(probe);
    await expect(second).rejects.toBeInstanceOf(CircuitBreakerOpenError);
    expect(probe).toHaveBeenCalledTimes(1);

    release(7);
    await expect(first).resolves.toBe(7);
    expect(breaker.currentState).toBe('CLOSED');
    await expect(breaker.fire(() => Promise.resolve(8))).resolves.toBe(8);
  });

  it('re-opens when the half-open probe fails', async () => {
    let now = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      now: () => now,
    });
    await expect(breaker.fire(fail)).rejects.toThrow('down');
    now = 1000;
    await expect(breaker.fire(fail)).rejects.toThrow('down');
    expect(breaker.currentState).toBe('OPEN');
    now = 1500;
    await expect(breaker.fire(fail)).rejects.toBeInstanceOf(
      CircuitBreakerOpenError,
    );
  });
});
