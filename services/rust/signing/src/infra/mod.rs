//! External-system clients — the Rust mirror of the backend's
//! `src/infrastructure/` (one module per external system; business code
//! injects the abstraction, never the driver).
//!
//! What belongs here: Redis/DB/broker clients, HTTP clients to other
//! services — each behind a trait defined here so `domain/` can depend on
//! the trait (dependency inversion) and tests can substitute fakes.
//!
//! the signing service is deliberately stateless pure computation (nonce replay
//! dedup stays with the gateway/backend caller — see `domain/signature.rs`),
//! so this module is empty today. If the service ever grows an external
//! dependency, its client lives here and nowhere else.
