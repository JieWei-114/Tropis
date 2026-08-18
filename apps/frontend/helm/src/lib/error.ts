// Error normalization now lives in @tropis/sdk — this module re-exports it so
// existing `lib/error` imports keep working.
export { parseApiError, type ApiError } from '@tropis/sdk';
