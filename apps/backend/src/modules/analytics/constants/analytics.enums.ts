/**
 * Domain enum for the analytics module.
 *
 * In constants/ rather than in the schema because it crosses the API boundary
 * (the gRPC controller and DTOs need it) while the schema is a persistence
 * detail — see `controllers-not-into-schemas` in .dependency-cruiser.cjs.
 */
export enum AnalyticsEventType {
  PAGE_VIEW = 'page_view',
  BUTTON_CLICK = 'button_click',
  API_CALL = 'api_call',
  ERROR = 'error',
  PURCHASE = 'purchase',
}
