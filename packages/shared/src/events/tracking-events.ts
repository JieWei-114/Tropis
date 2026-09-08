/**
 * Tracking event dictionary — the single source of truth for
 * user-behavior event names sent through the SDK tracker
 * (packages/sdk/src/tracking) to POST /api/v1/track → Pulsar → ClickHouse
 * `logs.user_behavior`.
 *
 * Naming convention: `<object>.<action>` (dot-separated, lowercase,
 * snake_case within a segment). Optionally `<area>.<object>.<action>` when
 * an object name would be ambiguous.
 *
 * Governance (see docs/tracking-plan.md):
 *   - New events MUST be added here AND to docs/tracking-plan.md BEFORE
 *     any code emits them.
 *   - Event names are API contracts: add-only. Never rename in place —
 *     deprecate the old entry and add a new one.
 *   - Frontend code must import names from this dictionary; no string
 *     literals at track() call sites.
 *
 * NOTE: this dictionary covers TRACKING events only. The analytics
 * pipeline's `AnalyticsEventType` enum ('page_view', 'button_click', ...)
 * in ./app-event.ts is a separate contract and is intentionally unchanged.
 */

export interface TrackingEventDef {
  /** Wire name stored in ClickHouse `logs.user_behavior.event_name`. */
  readonly name: string;
  /** When the event fires and what it means. */
  readonly description: string;
}

export const TRACKING_EVENTS = {
  /**
   * Fired automatically by the SDK tracker's `page()` on every route change
   * (frontend <PageTracker />).
   * Props: `{ path: string }` — the new pathname.
   */
  PAGE_VIEW: {
    name: 'page.view',
    description: 'Auto page view on every SPA route change (tracker.page).',
  },

  /**
   * Fired when a top-nav link is clicked (App.tsx <NavLink onClick>).
   * Props: `{ to: string; label: string }` — target route + link label.
   */
  NAV_CLICK: {
    name: 'nav.click',
    description: 'Top navigation link clicked.',
  },

  /**
   * Fired after a successful login (either mode) in LoginForm, right after
   * `tracker.identify(userId)`.
   * Props: `{ mode: 'login' | 'register' }` — which form mode led here.
   */
  USER_LOGIN: {
    name: 'user.login',
    description: 'User successfully signed in (fires for both form modes).',
  },

  /**
   * Fired after a successful registration in LoginForm, before auto-login.
   * Props: `{ email: string }`.
   */
  USER_REGISTER: {
    name: 'user.register',
    description: 'New account created via the register form.',
  },

  /**
   * Fired when a "Fire Event" demo button is pressed (FireEventPanel).
   * Props: `{ label: string; eventType: string }` — button label + which
   * AnalyticsEventType the button fires into the analytics pipeline.
   */
  BUTTON_CLICK: {
    name: 'button.click',
    description: 'Generic UI button click (currently: FireEventPanel buttons).',
  },

  /**
   * Fired the first time a user is bucketed into a feature-flag experiment
   * variant (see docs/tracking-plan.md → Experiments). Emit via
   * `tracker.exposeExperiment(experiment, variant)`.
   * Props: `{ experiment: string; variant: string }`.
   */
  EXPERIMENT_EXPOSED: {
    name: 'experiment.exposed',
    description: 'User exposed to an A/B experiment variant.',
  },

  /**
   * Fired once per Core Web Vitals metric as it settles, from the frontend
   * `reportWebVitals()` (src/lib/webVitals.ts). Lets real-user performance
   * (LCP/INP/CLS/FCP/TTFB) land in ClickHouse next to behavior events.
   * Props: `{ metric: string; value: number; rating: string; id: string;
   *          navigationType: string }`.
   */
  PERF_WEB_VITALS: {
    name: 'perf.web_vitals',
    description: 'A Core Web Vitals metric (LCP/INP/CLS/FCP/TTFB) settled.',
  },
} as const satisfies Record<string, TrackingEventDef>;
