//! Domain error enum + the single place mapping domain errors to transport
//! codes — mirrors the backend's exception filters
//! (`apps/backend/src/common/filters/grpc-exception.filter.ts`), which map
//! domain errors to the unified error-code table in one place.

use crate::domain::signature::REASON_API_KEY_UNKNOWN;

/// Errors the domain layer can produce. Transport-free: no tonic types here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DomainError {
    /// The requested `key_id` has no configured secret.
    UnknownApiKey,
}

/// domain error → gRPC status code, in exactly one place.
impl From<DomainError> for tonic::Status {
    fn from(err: DomainError) -> Self {
        match err {
            DomainError::UnknownApiKey => tonic::Status::not_found(REASON_API_KEY_UNKNOWN),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_api_key_maps_to_not_found() {
        let status: tonic::Status = DomainError::UnknownApiKey.into();
        assert_eq!(status.code(), tonic::Code::NotFound);
        assert_eq!(status.message(), "API_KEY_UNKNOWN");
    }
}
