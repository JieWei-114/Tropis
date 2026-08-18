/**
 * Core Web Vitals reporting.
 *
 * Measures the metrics Google uses for ranking (and that Lighthouse scores) and
 * forwards them to the existing tracking pipeline (埋点 → Pulsar → ClickHouse),
 * so real-user performance shows up next to behavior events instead of only in
 * a lab Lighthouse run.
 *
 *   LCP — Largest Contentful Paint (loading)
 *   INP — Interaction to Next Paint (responsiveness; replaced FID in 2024)
 *   CLS — Cumulative Layout Shift (visual stability)
 *   FCP — First Contentful Paint
 *   TTFB — Time To First Byte
 *
 * Call once, after the app mounts. No-ops safely if the tracker is unavailable.
 */

import { onCLS, onINP, onLCP, onFCP, onTTFB, type Metric } from 'web-vitals';
import { TRACKING_EVENTS } from '@tropis/shared';
import { tracker } from './tracking';

function report(metric: Metric): void {
  try {
    tracker.track(TRACKING_EVENTS.PERF_WEB_VITALS.name, {
      metric: metric.name,
      value: Math.round(metric.value),
      rating: metric.rating, // 'good' | 'needs-improvement' | 'poor'
      id: metric.id,
      navigationType: metric.navigationType,
    });
  } catch {
    // Never let telemetry break the app.
  }
}

export function reportWebVitals(): void {
  onCLS(report);
  onINP(report);
  onLCP(report);
  onFCP(report);
  onTTFB(report);
}
