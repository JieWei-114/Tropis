/**
 * Injection token for the Aerospike client (or null when the SDK/server is
 * unavailable — consumers must handle the degraded no-op mode).
 *
 * Lives in its own file so both aerospike.module.ts (provider) and
 * session.service.ts (consumer) can import it without a circular dependency.
 */
export const AEROSPIKE_CLIENT = 'AEROSPIKE_CLIENT';
