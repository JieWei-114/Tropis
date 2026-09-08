// Error normalization now lives in @tropis/sdk — this module re-exports it so
// existing `lib/error` imports keep working.
export { parseApiError } from '@tropis/sdk';
