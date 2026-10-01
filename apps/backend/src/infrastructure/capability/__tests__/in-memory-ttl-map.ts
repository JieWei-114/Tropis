/** Map with per-entry expiry, used by the in-memory fakes of each port. */
export class InMemoryTtlMap<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  set(key: string, value: V, ttlMs: number): void {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /** Remaining lifetime in ms, or undefined when absent. */
  ttlMs(key: string): number | undefined {
    return this.has(key)
      ? this.entries.get(key)!.expiresAt - Date.now()
      : undefined;
  }

  expire(key: string, ttlMs: number): boolean {
    const value = this.get(key);
    if (value === undefined) return false;
    this.set(key, value, ttlMs);
    return true;
  }

  delete(key: string): boolean {
    const had = this.has(key);
    this.entries.delete(key);
    return had;
  }
}
