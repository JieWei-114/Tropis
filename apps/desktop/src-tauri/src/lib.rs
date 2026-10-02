mod oauth;
mod secure_store;

use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;

use oauth::PendingCallback;
use secure_store::{KeyringBackend, SessionVault};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .manage(PendingCallback::default())
        .setup(|app| {
            let service = app.config().identifier.clone();
            app.manage(SessionVault::new(Box::new(KeyringBackend::new(&service))));

            #[cfg(all(debug_assertions, any(windows, target_os = "linux")))]
            app.deep_link().register_all()?;

            let handle = app.handle().clone();
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                oauth::deliver(&handle, &app.state::<PendingCallback>(), &urls);
            }
            app.deep_link().on_open_url(move |event| {
                let urls = event.urls();
                oauth::deliver(&handle, &handle.state::<PendingCallback>(), &urls);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            secure_store::session_token_get,
            secure_store::session_token_set,
            secure_store::session_token_clear,
            oauth::open_oauth_url,
            oauth::take_oauth_callback,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
