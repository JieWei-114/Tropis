const COMMANDS: &[&str] = &[
    "session_token_get",
    "session_token_set",
    "session_token_clear",
    "open_oauth_url",
    "take_oauth_callback",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
