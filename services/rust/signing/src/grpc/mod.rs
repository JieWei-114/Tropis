//! Transport layer — the Rust mirror of the backend's `controllers/`.
//!
//! THIN by rule: decode the proto request → call `domain/` → encode the
//! proto response. No business logic here.

pub mod signing;
