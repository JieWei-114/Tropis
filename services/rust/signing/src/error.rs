//! Domain error enum + the single place mapping domain errors to transport
//! codes. Every error carries a code of the shared error catalog
//! (`packages/shared/src/errors/catalog.ts`): the gRPC status code and the
//! message are that entry's `rpcCode` and `publicMessage`, and a
//! `google.rpc.ErrorInfo { reason: <code>, domain: "tropis" }` detail names
//! the code, as the backend's RPC errors do
//! (`apps/backend/src/infrastructure/rpc/rpc-errors.ts`).

use tonic_types::{ErrorDetails, StatusExt};

use crate::domain::signature::REASON_API_KEY_UNKNOWN;

/// `domain` of every ErrorInfo this system emits (catalog `ERROR_DOMAIN`).
pub(crate) const ERROR_DOMAIN: &str = "tropis";

/// Errors the domain layer can produce. Transport-free: no tonic types here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DomainError {
    /// The requested `key_id` has no configured secret.
    UnknownApiKey,
}

/// The catalog entry of a domain error: (code, gRPC code, public message).
fn catalog_entry(err: &DomainError) -> (&'static str, tonic::Code, &'static str) {
    match err {
        DomainError::UnknownApiKey => (
            REASON_API_KEY_UNKNOWN,
            tonic::Code::Unauthenticated,
            "The API key is not recognised.",
        ),
    }
}

/// domain error → gRPC status, in exactly one place.
impl From<DomainError> for tonic::Status {
    fn from(err: DomainError) -> Self {
        let (code, rpc_code, message) = catalog_entry(&err);
        let details = ErrorDetails::with_error_info(
            code,
            ERROR_DOMAIN,
            [("retryable".to_string(), "false".to_string())],
        );
        tonic::Status::with_error_details(rpc_code, message, details)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_api_key_maps_to_unauthenticated_with_the_catalog_code() {
        let status: tonic::Status = DomainError::UnknownApiKey.into();
        assert_eq!(status.code(), tonic::Code::Unauthenticated);
        assert_eq!(status.message(), "The API key is not recognised.");
        let info = status.get_details_error_info().expect("ErrorInfo");
        assert_eq!(info.reason, "API_KEY_UNKNOWN");
        assert_eq!(info.domain, "tropis");
        assert_eq!(
            info.metadata.get("retryable").map(String::as_str),
            Some("false")
        );
    }

    /// The entry must stay identical to the shared catalog's.
    #[test]
    fn catalog_entries_match_the_shared_catalog() {
        let catalog = include_str!("../../../../packages/shared/src/errors/catalog.ts");
        let (code, rpc_code, message) = catalog_entry(&DomainError::UnknownApiKey);
        let start = catalog
            .find(&format!("  {code}: {{"))
            .expect("code in the catalog");
        let entry = &catalog[start..start + catalog[start..].find("},").unwrap()];
        assert!(entry.contains("rpcCode: 'Unauthenticated'"), "{entry}");
        assert_eq!(rpc_code, tonic::Code::Unauthenticated);
        assert!(
            entry.contains(&format!("publicMessage: '{message}'")),
            "{entry}"
        );
        assert!(entry.contains("retryable: false"), "{entry}");
    }
}
