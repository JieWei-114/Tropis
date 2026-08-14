//! HMAC-SHA256 request-signature computation & verification.
//!
//! Implements the scheme from `docs/api-conventions.md`, byte-for-byte
//! compatible with the TypeScript implementations:
//!
//! - backend guard: `apps/backend/src/common/guards/signature.guard.ts`
//! - SDK client:    `packages/sdk/src/signing/index.ts`
//!
//! Canonical string:
//!
//! ```text
//! METHOD \n PATH \n timestamp \n nonce \n SHA256(body) as lowercase hex
//! signature = hex(HMAC-SHA256(secret, canonical))
//! ```
//!
//! This service is *pure computation* and therefore stateless and
//! horizontally scalable — that is the point of the Rust example. Nonce
//! replay dedup (Redis `SET NX EX 300`) is deliberately NOT here: it is
//! owned by the gateway/backend caller, which has the Redis connection
//! and the request context.

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::error::DomainError;

/// Signed requests are valid for ±300 s around the server clock — mirrors
/// `SIGNATURE_MAX_SKEW_SECONDS` in the backend guard.
pub(crate) const SIGNATURE_MAX_SKEW_SECONDS: i64 = 300;

/// Verification reason strings — the shared vocabulary with the TS guard
/// (`VerifySignatureResponse.reason` in the proto contract).
pub(crate) const REASON_OK: &str = "OK";
pub(crate) const REASON_SIGNATURE_EXPIRED: &str = "SIGNATURE_EXPIRED";
pub(crate) const REASON_API_KEY_UNKNOWN: &str = "API_KEY_UNKNOWN";
pub(crate) const REASON_SIGNATURE_INVALID: &str = "SIGNATURE_INVALID";

type HmacSha256 = Hmac<Sha256>;

/// A request to sign/verify, already decoded from the transport.
/// Plain data — keeps `domain/` free of proto/tonic types.
#[derive(Debug, Clone)]
pub(crate) struct SigningInput<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub timestamp: i64,
    pub nonce: &'a str,
    pub body: &'a [u8],
    pub key_id: &'a str,
}

/// Outcome of a verification — maps 1:1 onto the proto's `valid` + `reason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum VerifyOutcome {
    Valid,
    Expired,
    UnknownKey,
    Invalid,
}

impl VerifyOutcome {
    pub(crate) fn is_valid(self) -> bool {
        matches!(self, Self::Valid)
    }

    pub(crate) fn reason(self) -> &'static str {
        match self {
            Self::Valid => REASON_OK,
            Self::Expired => REASON_SIGNATURE_EXPIRED,
            Self::UnknownKey => REASON_API_KEY_UNKNOWN,
            Self::Invalid => REASON_SIGNATURE_INVALID,
        }
    }
}

/// Builds the canonical string. Must match `buildCanonicalString` in the
/// backend guard and the SDK.
pub(crate) fn build_canonical_string(
    method: &str,
    path: &str,
    timestamp: i64,
    nonce: &str,
    body: &[u8],
) -> String {
    let body_hash = hex::encode(Sha256::digest(body));
    format!(
        "{}\n{}\n{}\n{}\n{}",
        method.to_uppercase(),
        path,
        timestamp,
        nonce,
        body_hash
    )
}

/// `hex(HMAC-SHA256(secret, canonical))`, lowercase.
pub(crate) fn compute_signature(secret: &str, canonical: &str) -> String {
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(canonical.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// Current unix time in seconds.
pub(crate) fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before unix epoch")
        .as_secs() as i64
}

/// Key store: `{keyId: secret}` — the same JSON map format the backend
/// uses in the `API_KEYS` env var (parsed/validated in `config.rs`).
#[derive(Debug, Default, Clone)]
pub(crate) struct KeyStore {
    keys: HashMap<String, String>,
}

impl KeyStore {
    pub(crate) fn new(keys: HashMap<String, String>) -> Self {
        Self { keys }
    }

    fn secret(&self, key_id: &str) -> Option<&str> {
        self.keys.get(key_id).map(String::as_str)
    }

    /// Computes the signature for `input`, or `UnknownApiKey` if the key
    /// id has no configured secret.
    pub(crate) fn compute(&self, input: &SigningInput<'_>) -> Result<String, DomainError> {
        let secret = self
            .secret(input.key_id)
            .ok_or(DomainError::UnknownApiKey)?;
        let canonical = build_canonical_string(
            input.method,
            input.path,
            input.timestamp,
            input.nonce,
            input.body,
        );
        Ok(compute_signature(secret, &canonical))
    }

    /// Verifies `signature` against `input` at time `now`:
    ///
    /// 1. Timestamp window ±300 s (mirrors the TS guard order; header
    ///    presence is the transport's concern — proto fields exist).
    /// 2. Key lookup.
    /// 3. Recompute and compare constant-time (`subtle::ConstantTimeEq`).
    ///    Nonce replay dedup is the caller's concern — see module docs.
    pub(crate) fn verify(
        &self,
        input: &SigningInput<'_>,
        signature: &str,
        now: i64,
    ) -> VerifyOutcome {
        if (now - input.timestamp).abs() > SIGNATURE_MAX_SKEW_SECONDS {
            return VerifyOutcome::Expired;
        }
        let Ok(expected) = self.compute(input) else {
            return VerifyOutcome::UnknownKey;
        };
        if bool::from(expected.as_bytes().ct_eq(signature.as_bytes())) {
            VerifyOutcome::Valid
        } else {
            VerifyOutcome::Invalid
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SHARED TEST VECTOR — must stay byte-for-byte in sync with:
    ///   - apps/backend/src/common/guards/__tests__/signature.guard.spec.ts
    ///   - packages/sdk/src/signing/__tests__/signing.test.ts
    ///
    /// All THREE suites (backend guard, TS SDK, this Rust service) pin the
    /// same canonical string → signature pair; changing the signing scheme
    /// must update all of them together.
    struct Vector {
        method: &'static str,
        path: &'static str,
        timestamp: i64,
        nonce: &'static str,
        body: &'static str,
        key_id: &'static str,
        secret: &'static str,
        body_sha256: &'static str,
        expected_signature: &'static str,
    }

    const VECTOR: Vector = Vector {
        method: "POST",
        path: "/api/v1/track/secure",
        timestamp: 1_700_000_000,
        nonce: "7f9c24e5-1c4b-4c8a-9d3e-2f6a8b1c0d5e",
        body: r#"{"events":[{"eventName":"button_click"}]}"#,
        key_id: "svc-test",
        secret: "test-secret-material-for-hmac-vector",
        body_sha256: "589fabdc0395d7b757c76d16bed4b9ea44bc8e5d4c6a5a36f2cc4f653daf52e8",
        expected_signature: "c2c9224d1fb33aef647e7e66b3ca45ffc0fcd9f3e538bda90dd8b49128c50f9d",
    };

    fn store() -> KeyStore {
        KeyStore::new(HashMap::from([(
            VECTOR.key_id.to_string(),
            VECTOR.secret.to_string(),
        )]))
    }

    fn input(timestamp: i64) -> SigningInput<'static> {
        SigningInput {
            method: VECTOR.method,
            path: VECTOR.path,
            timestamp,
            nonce: VECTOR.nonce,
            body: VECTOR.body.as_bytes(),
            key_id: VECTOR.key_id,
        }
    }

    #[test]
    fn canonical_string_matches_the_shared_vector() {
        let canonical = build_canonical_string(
            VECTOR.method,
            VECTOR.path,
            VECTOR.timestamp,
            VECTOR.nonce,
            VECTOR.body.as_bytes(),
        );
        assert_eq!(
            canonical,
            format!(
                "POST\n{}\n{}\n{}\n{}",
                VECTOR.path, VECTOR.timestamp, VECTOR.nonce, VECTOR.body_sha256
            )
        );
    }

    #[test]
    fn signature_matches_the_ts_backend_and_sdk() {
        let canonical = build_canonical_string(
            VECTOR.method,
            VECTOR.path,
            VECTOR.timestamp,
            VECTOR.nonce,
            VECTOR.body.as_bytes(),
        );
        assert_eq!(
            compute_signature(VECTOR.secret, &canonical),
            VECTOR.expected_signature
        );
    }

    #[test]
    fn compute_returns_the_vector_signature() {
        let sig = store().compute(&input(VECTOR.timestamp)).unwrap();
        assert_eq!(sig, VECTOR.expected_signature);
    }

    #[test]
    fn compute_rejects_unknown_key() {
        let mut req = input(VECTOR.timestamp);
        req.key_id = "nope";
        assert_eq!(store().compute(&req), Err(DomainError::UnknownApiKey));
    }

    #[test]
    fn verify_rejects_expired_timestamp() {
        // Vector timestamp is 2023 — far outside ±300 s of "now".
        let outcome = store().verify(
            &input(VECTOR.timestamp),
            VECTOR.expected_signature,
            now_secs(),
        );
        assert!(!outcome.is_valid());
        assert_eq!(outcome.reason(), REASON_SIGNATURE_EXPIRED);
    }

    #[test]
    fn verify_accepts_a_fresh_valid_signature_and_rejects_tampering() {
        let now = now_secs();
        let req = input(now);
        let sig = store().compute(&req).unwrap();

        let ok = store().verify(&req, &sig, now);
        assert!(ok.is_valid());
        assert_eq!(ok.reason(), REASON_OK);

        let mut tampered = req.clone();
        tampered.body = b"tampered";
        let bad = store().verify(&tampered, &sig, now);
        assert!(!bad.is_valid());
        assert_eq!(bad.reason(), REASON_SIGNATURE_INVALID);
    }

    #[test]
    fn verify_rejects_unknown_key() {
        let now = now_secs();
        let mut req = input(now);
        req.key_id = "nope";
        let outcome = store().verify(&req, VECTOR.expected_signature, now);
        assert!(!outcome.is_valid());
        assert_eq!(outcome.reason(), REASON_API_KEY_UNKNOWN);
    }

    #[test]
    fn timestamp_window_boundary_is_inclusive() {
        let now = now_secs();
        let req = input(now - SIGNATURE_MAX_SKEW_SECONDS);
        let sig = store().compute(&req).unwrap();
        assert!(store().verify(&req, &sig, now).is_valid());

        let req = input(now - SIGNATURE_MAX_SKEW_SECONDS - 1);
        let sig = store().compute(&req).unwrap();
        assert_eq!(store().verify(&req, &sig, now), VerifyOutcome::Expired);
    }
}
