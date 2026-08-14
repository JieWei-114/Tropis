//! Env parsing + validation. Fail fast at startup with a clear message —
//! mirrors the backend's Joi env validation (`src/config/env.validation.ts`).

use std::collections::HashMap;

/// Typed, validated service configuration. Built once in `main.rs`.
#[derive(Debug, Clone)]
pub struct Config {
    /// JSON map `{keyId: secret}` from `API_KEYS` — same format as the backend.
    pub api_keys: HashMap<String, String>,
    /// Listen port from `GRPC_PORT` (default 50052).
    pub grpc_port: u16,
}

impl Config {
    /// Reads and validates `API_KEYS` + `GRPC_PORT` from the environment.
    pub fn from_env() -> Result<Self, String> {
        let raw_keys = std::env::var("API_KEYS").unwrap_or_else(|_| "{}".to_string());
        let raw_port = std::env::var("GRPC_PORT").ok();
        Self::parse(&raw_keys, raw_port.as_deref())
    }

    /// Pure parse/validate step, separated from env access for testability.
    pub fn parse(raw_keys: &str, raw_port: Option<&str>) -> Result<Self, String> {
        let api_keys: HashMap<String, String> = serde_json::from_str(raw_keys)
            .map_err(|e| format!("API_KEYS is not a JSON map: {e}"))?;
        let grpc_port = match raw_port {
            Some(p) => p
                .parse()
                .map_err(|e| format!("GRPC_PORT is not a valid port: {e}"))?,
            None => 50052,
        };
        Ok(Self {
            api_keys,
            grpc_port,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_defaults() {
        let cfg = Config::parse("{}", None).unwrap();
        assert!(cfg.api_keys.is_empty());
        assert_eq!(cfg.grpc_port, 50052);
    }

    #[test]
    fn parses_keys_and_port() {
        let cfg = Config::parse(r#"{"svc":"secret"}"#, Some("50099")).unwrap();
        assert_eq!(cfg.api_keys.get("svc").map(String::as_str), Some("secret"));
        assert_eq!(cfg.grpc_port, 50099);
    }

    #[test]
    fn rejects_invalid_api_keys_json() {
        let err = Config::parse("not-json", None).unwrap_err();
        assert!(err.contains("API_KEYS is not a JSON map"));
    }

    #[test]
    fn rejects_invalid_port() {
        let err = Config::parse("{}", Some("banana")).unwrap_err();
        assert!(err.contains("GRPC_PORT is not a valid port"));
    }
}
