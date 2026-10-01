/** A Map-backed Web Storage for tests that run without a DOM. */
export function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => {
      data.delete(k);
    },
    setItem: (k, v) => {
      data.set(k, String(v));
    },
  };
}

/** An unsigned JWT whose `exp` is `secondsFromNow` away. */
export function jwt(secondsFromNow = 600): string {
  const b64 = (v: object) =>
    btoa(JSON.stringify(v))
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  return `${b64({ alg: 'none' })}.${b64({
    exp: Math.floor(Date.now() / 1000) + secondsFromNow,
  })}.sig`;
}
