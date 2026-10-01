/**
 * The shared Aerospike client, or null when the SDK or server is
 * unavailable. Used only by the kv aerospike adapter.
 */
export const AEROSPIKE_CLIENT = Symbol('AEROSPIKE_CLIENT');
