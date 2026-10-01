import { defineKey } from '../keyspace';

/** Signed requests are valid for ±300 s around the server clock. */
export const SIGNATURE_MAX_SKEW_SECONDS = 300;

/** Nonces are remembered for the full validity window. */
export const NONCE_TTL_SECONDS = SIGNATURE_MAX_SKEW_SECONDS;

/** Used request nonces: global(keyId, nonce). */
export const SIGNATURE_NONCE_KEY = defineKey({
  capability: 'dedup',
  module: 'signature',
  name: 'nonce',
  version: 'v1',
});
