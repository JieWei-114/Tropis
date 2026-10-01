//! tropis.signing.v1.SigningService — stateless HMAC request-signature gRPC
//! service. See README.md and docs/api-conventions.md.
//!
//! Layering (the Rust service anatomy — docs/project-structure.md):
//!
//! ```text
//! grpc/ (transport)  →  domain/ (business logic)  →  infra/ (external clients)
//! ```
//!
//! The compiler enforces the crate boundary: `domain/`, `error/` and `infra/`
//! are `pub(crate)`, so `main.rs` and `tests/` cannot reach them and a domain
//! type in a `pub` signature fails to compile (E0446). The direction inside
//! the crate — `domain/` never importing `grpc/` or tonic/prost types — is a
//! code-review rule.

pub mod config;
pub(crate) mod domain;
pub(crate) mod error;
pub mod grpc;
pub(crate) mod infra;

/// Generated types for tropis.signing.v1 (build.rs → tonic-prost-build).
pub mod pb {
    tonic::include_proto!("tropis.signing.v1");
}
