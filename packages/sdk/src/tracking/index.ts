/**
 * Tracking — client-side user-behavior tracker.
 *
 * Design:
 *   - Events are buffered and flushed as a batch to `POST <endpoint>` (the
 *     backend's REST ingest, /api/v1/track). REST because gRPC-Web cannot be
 *     used with navigator.sendBeacon.
 *   - Flush triggers: buffer reaches maxBatch, the flush interval fires, or
 *     the page is being hidden/unloaded (visibilitychange:hidden + pagehide),
 *     where delivery uses navigator.sendBeacon with a fetch(keepalive) fallback.
 *   - Fire-and-forget: tracking must NEVER throw or break the host app.
 *   - SSR/Node safe: when `window` is undefined every method is a no-op.
 */

export interface TrackerOptions {
  /** Full ingest URL, e.g. http://localhost:3100/api/v1/track */
  endpoint: string;
  /** Optional bearer token supplier (ingest is public; token is optional). */
  getToken?: () => string | null;
  /** Interval between automatic flushes (default 5000 ms). */
  flushIntervalMs?: number;
  /** Flush as soon as the buffer reaches this size (default 10). */
  maxBatch?: number;
}

export interface TrackedEvent {
  eventId: string;
  eventName: string;
  anonymousId: string;
  userId?: string;
  sessionId: string;
  page: string;
  referrer: string;
  userAgent: string;
  screen: string;
  props: Record<string, unknown>;
  timestamp: number; // epoch ms
}

export interface Tracker {
  /** Record a named event with optional properties. Never throws. */
  track(event: string, props?: Record<string, unknown>): void;
  /** Record a page view. */
  page(path: string): void;
  /** Attach a userId — subsequent events carry both anonymousId and userId. */
  identify(userId: string): void;
  /**
   * Record an A/B experiment exposure — emits the registered
   * 'experiment.exposed' tracking event with { experiment, variant }
   * (see docs/tracking-plan.md → Experiments).
   */
  exposeExperiment(experiment: string, variant: string): void;
  /** Force-send the current buffer. */
  flush(): void;
  /** Flush and remove all listeners/timers. */
  destroy(): void;
}

const ANON_ID_KEY = 'trk_anon_id';
const SESSION_KEY = 'trk_session';
const SESSION_TTL_MS = 30 * 60 * 1000; // 30-min sliding window

// ── Helpers (all defensive: storage may be unavailable) ──────────────────────

function uuid(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID)
      return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  // RFC4122-ish fallback
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function getAnonymousId(): string {
  try {
    const existing = window.localStorage.getItem(ANON_ID_KEY);
    if (existing) return existing;
    const id = uuid();
    window.localStorage.setItem(ANON_ID_KEY, id);
    return id;
  } catch {
    return uuid();
  }
}

/** Session id in sessionStorage with a 30-minute sliding expiry. */
function getSessionId(): string {
  const now = Date.now();
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (raw) {
      const { id, ts } = JSON.parse(raw) as { id: string; ts: number };
      if (id && now - ts < SESSION_TTL_MS) {
        window.sessionStorage.setItem(
          SESSION_KEY,
          JSON.stringify({ id, ts: now }),
        );
        return id;
      }
    }
    const id = uuid();
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id, ts: now }));
    return id;
  } catch {
    return 'no-session';
  }
}

const NOOP_TRACKER: Tracker = {
  track: () => undefined,
  page: () => undefined,
  identify: () => undefined,
  exposeExperiment: () => undefined,
  flush: () => undefined,
  destroy: () => undefined,
};

// ── Factory ───────────────────────────────────────────────────────────────────

export function createTracker(options: TrackerOptions): Tracker {
  // SSR / Node safety — no window, no tracking.
  if (typeof window === 'undefined') return NOOP_TRACKER;

  const { endpoint, getToken, flushIntervalMs = 5000, maxBatch = 10 } = options;

  const anonymousId = getAnonymousId();
  let userId: string | undefined;
  let buffer: TrackedEvent[] = [];
  let destroyed = false;

  const context = () => ({
    page: window.location?.pathname ?? '',
    referrer: typeof document !== 'undefined' ? document.referrer : '',
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    screen: window.screen
      ? `${window.screen.width}x${window.screen.height}`
      : '',
  });

  /** Send a batch. `beacon: true` on page hide (sendBeacon survives unload). */
  const send = (events: TrackedEvent[], beacon: boolean): void => {
    if (events.length === 0) return;
    const body = JSON.stringify({ events });
    try {
      if (beacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
        const ok = navigator.sendBeacon(
          endpoint,
          new Blob([body], { type: 'application/json' }),
        );
        if (ok) return;
        // fall through to fetch if the beacon was rejected (e.g. quota)
      }
      const token = getToken?.();
      void fetch(endpoint, {
        method: 'POST',
        keepalive: true,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body,
      }).catch(() => undefined);
    } catch {
      /* fire-and-forget — never throw */
    }
  };

  const flushBuffer = (beacon = false): void => {
    const events = buffer;
    buffer = [];
    send(events, beacon);
  };

  const enqueue = (eventName: string, props: Record<string, unknown>): void => {
    if (destroyed) return;
    try {
      buffer.push({
        eventId: uuid(),
        eventName,
        anonymousId,
        userId,
        sessionId: getSessionId(),
        props,
        timestamp: Date.now(),
        ...context(),
      });
      if (buffer.length >= maxBatch) flushBuffer();
    } catch {
      /* never throw */
    }
  };

  // ── Flush triggers ──────────────────────────────────────────────────────
  const timer = window.setInterval(() => flushBuffer(), flushIntervalMs);

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') flushBuffer(true);
  };
  const onPageHide = () => flushBuffer(true);

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);

  return {
    track(event, props = {}) {
      enqueue(event, props);
    },
    page(path) {
      // Name registered in @tropis/shared TRACKING_EVENTS.PAGE_VIEW
      // (the SDK deliberately has no dependency on @tropis/shared).
      enqueue('page.view', { path });
    },
    identify(id) {
      userId = id;
    },
    exposeExperiment(experiment, variant) {
      // Name registered in @tropis/shared TRACKING_EVENTS.EXPERIMENT_EXPOSED.
      enqueue('experiment.exposed', { experiment, variant });
    },
    flush() {
      flushBuffer();
    },
    destroy() {
      flushBuffer(true);
      destroyed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    },
  };
}
