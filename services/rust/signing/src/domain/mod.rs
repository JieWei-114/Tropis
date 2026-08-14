//! Business logic — the Rust mirror of the backend's `services/` layer.
//!
//! PURE where possible (no IO) and fully unit-tested. Everything here is
//! `pub(crate)` and imports no tonic/prost types: the compiler itself
//! enforces that the domain never depends on the transport.

pub(crate) mod signature;
