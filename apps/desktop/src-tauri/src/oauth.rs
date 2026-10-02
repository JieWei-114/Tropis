use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Runtime, State, Url};
use tauri_plugin_opener::OpenerExt;

pub const CALLBACK_EVENT: &str = "oauth-callback";
const CALLBACK_SCHEME: &str = "tropis";
const CALLBACK_HOST: &str = "auth";
const CALLBACK_PATH: &str = "/callback";
const PROVIDERS: [&str; 2] = ["google", "github"];

/// The last OAuth callback deep link, kept until the web app takes it.
#[derive(Default)]
pub struct PendingCallback(Mutex<Option<String>>);

/// An OAuth start URL of the API: http(s), `/api/auth/<provider>`, no credentials.
pub fn is_oauth_start_url(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw) else {
        return false;
    };
    if !matches!(url.scheme(), "https" | "http") || url.host_str().is_none() {
        return false;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let path = url.path().trim_end_matches('/');
    PROVIDERS
        .iter()
        .any(|p| path.ends_with(&format!("/api/auth/{p}")))
}

/// `tropis://auth/callback#code=...`, the return URL of a native sign-in.
pub fn is_callback_url(url: &Url) -> bool {
    url.scheme() == CALLBACK_SCHEME
        && url.host_str() == Some(CALLBACK_HOST)
        && url.path() == CALLBACK_PATH
}

/// Hands a callback deep link to the web app: kept for `take_oauth_callback`
/// and announced as an event. Other URLs are ignored.
pub fn deliver<R: Runtime>(app: &AppHandle<R>, pending: &PendingCallback, urls: &[Url]) {
    for url in urls.iter().filter(|u| is_callback_url(u)) {
        let value = url.to_string();
        if let Ok(mut slot) = pending.0.lock() {
            *slot = Some(value.clone());
        }
        let _ = app.emit(CALLBACK_EVENT, value);
    }
}

#[tauri::command]
pub fn open_oauth_url<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    if !is_oauth_start_url(&url) {
        return Err("not an OAuth start URL".to_owned());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "could not open the browser".to_owned())
}

#[tauri::command]
pub fn take_oauth_callback(pending: State<'_, PendingCallback>) -> Option<String> {
    pending.0.lock().ok().and_then(|mut slot| slot.take())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_api_oauth_start_urls() {
        for ok in [
            "https://api.example.com/api/auth/google?challenge=abc&redirect=tropis%3A%2F%2Fauth%2Fcallback",
            "http://192.168.1.20:3100/api/auth/github?challenge=abc",
        ] {
            assert!(is_oauth_start_url(ok), "{ok}");
        }
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "tropis://auth/callback",
            "https://evil.example/phish",
            "https://user:pw@api.example.com/api/auth/google",
            "https://api.example.com/api/auth/other",
            "not a url",
        ] {
            assert!(!is_oauth_start_url(bad), "{bad}");
        }
    }

    #[test]
    fn recognises_the_callback_deep_link_only() {
        let ok = Url::parse("tropis://auth/callback#code=abc").unwrap();
        assert!(is_callback_url(&ok));
        for bad in [
            "tropis://auth/other#code=abc",
            "tropis://evil/callback#code=abc",
            "other://auth/callback#code=abc",
            "https://auth/callback#code=abc",
        ] {
            assert!(!is_callback_url(&Url::parse(bad).unwrap()), "{bad}");
        }
    }

    #[test]
    fn a_pending_callback_is_taken_once() {
        let pending = PendingCallback::default();
        *pending.0.lock().unwrap() = Some("tropis://auth/callback#code=x".to_owned());
        assert_eq!(
            pending.0.lock().unwrap().take().as_deref(),
            Some("tropis://auth/callback#code=x")
        );
        assert_eq!(pending.0.lock().unwrap().take(), None);
    }
}
