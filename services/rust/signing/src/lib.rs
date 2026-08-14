//! tropis.signing.v1.SigningService — stateless HMAC request-signature gRPC
//! service. See README.md and docs/api-conventions.md.
//!
//! Layering (the Rust service anatomy — docs/project-structure.md):
//!
//! ```text
//! grpc/ (transport)  →  domain/ (business logic)  →  infra/ (external clients)
//! ```
//!
//! The one-way rule is **compiler-enforced**: everything in `domain/` is
//! `pub(crate)`, so it cannot leak outside the crate, and `domain/` imports
//! no tonic/prost types — a `use tonic::…` in `domain/` has nothing to
//! attach to and any transport type crossing into a domain signature fails
//! `pub(crate)` visibility checks (E0446). Stronger than dependency-cruiser.

pub mod config;
pub(crate) mod domain;
pub(crate) mod error;
pub mod grpc;
pub(crate) mod infra;

/// Generated types for tropis.signing.v1 (build.rs → tonic-prost-build).
pub mod pb {
    tonic::include_proto!("tropis.signing.v1");
}
