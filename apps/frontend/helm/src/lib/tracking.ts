/**
 * App-wide user-behavior tracker singleton.
 *
 * Delivery: batches to POST /api/v1/track (REST — sendBeacon-compatible),
 * then backend → Pulsar → TrackingProcessor → ClickHouse.
 *
 * Usage: explicit calls — `tracker.track(TRACKING_EVENTS.NAV_CLICK.name, { to })` (names come from
 * the @tropis/shared TRACKING_EVENTS dictionary — see docs/tracking-plan.md),
 * `tracker.page(path)` via <PageTracker /> on route change,
 * `tracker.identify(userId)` after login.
 */

import { createTracker, getToken } from '@tropis/sdk';
import { env } from './env';

export const tracker = createTracker({
  endpoint: `${env.VITE_API_BASE_URL}/api/v1/track`,
  getToken,
});
