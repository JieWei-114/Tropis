use std::sync::Mutex;

use tauri::State;

const ACCOUNT: &str = "refresh-token";
const MAX_TOKEN_LEN: usize = 2048;

pub trait SecretBackend: Send + Sync {
    fn get(&self) -> Result<Option<String>, String>;
    fn set(&self, value: &str) -> Result<(), String>;
    fn clear(&self) -> Result<(), String>;
}

pub struct KeyringBackend {
    service: String,
}

impl KeyringBackend {
    pub fn new(service: &str) -> Self {
        Self {
            service: service.to_owned(),
        }
    }

    fn entry(&self) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, ACCOUNT).map_err(|_| "keyring unavailable".to_owned())
    }
}

impl SecretBackend for KeyringBackend {
    fn get(&self) -> Result<Option<String>, String> {
        match self.entry()?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("keyring read failed".to_owned()),
        }
    }

    fn set(&self, value: &str) -> Result<(), String> {
        self.entry()?
            .set_password(value)
            .map_err(|_| "keyring write failed".to_owned())
    }

    fn clear(&self) -> Result<(), String> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("keyring delete failed".to_owned()),
        }
    }
}

/// The native session's refresh token, kept in the OS keyring.
pub struct SessionVault {
    backend: Box<dyn SecretBackend>,
    lock: Mutex<()>,
}

impl SessionVault {
    pub fn new(backend: Box<dyn SecretBackend>) -> Self {
        Self {
            backend,
            lock: Mutex::new(()),
        }
    }

    pub fn get(&self) -> Result<Option<String>, String> {
        let _guard = self.lock.lock().map_err(|_| "vault poisoned".to_owned())?;
        Ok(self.backend.get()?.filter(|t| is_token(t)))
    }

    pub fn set(&self, token: &str) -> Result<(), String> {
        if !is_token(token) {
            return Err("invalid token".to_owned());
        }
        let _guard = self.lock.lock().map_err(|_| "vault poisoned".to_owned())?;
        self.backend.set(token)
    }

    pub fn clear(&self) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|_| "vault poisoned".to_owned())?;
        self.backend.clear()
    }
}

fn is_token(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= MAX_TOKEN_LEN
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[tauri::command]
pub fn session_token_get(vault: State<'_, SessionVault>) -> Result<Option<String>, String> {
    vault.get()
}

#[tauri::command]
pub fn session_token_set(vault: State<'_, SessionVault>, token: String) -> Result<(), String> {
    vault.set(&token)
}

#[tauri::command]
pub fn session_token_clear(vault: State<'_, SessionVault>) -> Result<(), String> {
    vault.clear()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[derive(Default)]
    struct MemoryBackend {
        value: Mutex<Option<String>>,
        fail: bool,
    }

    impl SecretBackend for Arc<MemoryBackend> {
        fn get(&self) -> Result<Option<String>, String> {
            if self.fail {
                return Err("down".to_owned());
            }
            Ok(self.value.lock().unwrap().clone())
        }
        fn set(&self, value: &str) -> Result<(), String> {
            *self.value.lock().unwrap() = Some(value.to_owned());
            Ok(())
        }
        fn clear(&self) -> Result<(), String> {
            *self.value.lock().unwrap() = None;
            Ok(())
        }
    }

    fn vault() -> (SessionVault, Arc<MemoryBackend>) {
        let backend = Arc::new(MemoryBackend::default());
        (SessionVault::new(Box::new(backend.clone())), backend)
    }

    #[test]
    fn stores_reads_and_clears_a_token() {
        let (vault, _) = vault();
        assert_eq!(vault.get().unwrap(), None);
        vault.set("eyJ0ZW5hbnQi_abc-123").unwrap();
        assert_eq!(
            vault.get().unwrap().as_deref(),
            Some("eyJ0ZW5hbnQi_abc-123")
        );
        vault.clear().unwrap();
        assert_eq!(vault.get().unwrap(), None);
        vault.clear().unwrap();
    }

    #[test]
    fn refuses_values_that_are_not_a_base64url_token() {
        let (vault, backend) = vault();
        for bad in [
            "",
            "has space",
            "a\nb",
            "x=y",
            &"a".repeat(MAX_TOKEN_LEN + 1),
        ] {
            assert!(vault.set(bad).is_err(), "{bad:?}");
        }
        assert_eq!(*backend.value.lock().unwrap(), None);
    }

    #[test]
    fn ignores_a_stored_value_that_is_not_a_token() {
        let (vault, backend) = vault();
        *backend.value.lock().unwrap() = Some("not a token".to_owned());
        assert_eq!(vault.get().unwrap(), None);
    }

    #[test]
    fn reports_a_backend_failure() {
        let backend = Arc::new(MemoryBackend {
            fail: true,
            ..Default::default()
        });
        let vault = SessionVault::new(Box::new(backend));
        assert!(vault.get().is_err());
    }
}
