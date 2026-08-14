# Desktop Shell (Tauri v2)

Wraps the web frontend (`frontend/helm`) into native desktop installers
(.app/.dmg/.exe/.deb). It is a **shell, not an app**: it contains zero business
logic and renders the exact same build the browser gets.

Channel overview and store submission: [docs/multi-platform.md](../../docs/multi-platform.md).

## Layout & what goes where

```
apps/desktop/
├── package.json            # @tropis/desktop — only the Tauri CLI, no runtime JS
└── src-tauri/               # the Rust shell crate
    ├── tauri.conf.json      # ⭐ the config: window size/title, productName,
    │                        #   identifier (dev.tropis.app — replace before release),
    │                        #   frontendDist → ../../frontend/dist,
    │                        #   beforeBuildCommand builds the frontend first
    ├── capabilities/        # ⭐ permission grants per window (deny-by-default).
    │   └── default.json     #   Only core:default now. Every new permission is a
    │                        #   security decision — add the narrowest one that works.
    ├── src/
    │   ├── main.rs          # entry point — DO NOT add logic here
    │   └── lib.rs           # builder wiring; native commands go here (see rules)
    ├── icons/               # generated set — regenerate via `pnpm tauri icon <1024px.png>`
    ├── build.rs             # tauri build glue (generated, don't edit)
    └── Cargo.toml           # standalone crate (detached [workspace] on purpose —
                             #   it's an app shell, not a services/rust member)
```

## Rules (mirror of the platform's layering discipline)

1. **No business logic in the shell.** Features live in the web app
   (`frontend/helm` → `@tropis/sdk`). If a feature works in the browser, it works
   here for free — that's the entire point.
2. **Native (Rust) commands only for what the web platform cannot do**: file
   system dialogs, tray, global shortcuts, OS notifications beyond web push,
   auto-update. Pattern: `#[tauri::command]` fn in `lib.rs` (extract to
   `src/commands/` when there are more than ~2), registered via
   `.invoke_handler(...)`, called from the frontend with `@tauri-apps/api`'s
   `invoke()`. Each command needs a matching capability entry.
3. **Capabilities are deny-by-default** — treat `capabilities/*.json` like the
   backend's OPA policies: the narrowest permission, reviewed in PR.
4. **API endpoints are baked at web build time** (`VITE_*`): a desktop build
   talks to whatever backend the frontend build was pointed at — set
   `frontend/helm/.env` before `make desktop` (see docs/multi-platform.md).
5. **Before release**: replace `identifier` (bundle ID), `productName`, and the
   icon set; set up signing/notarization per OS (pointers in
   docs/multi-platform.md).

## Commands

```bash
make desktop                     # repo root: builds frontend, then installers
cd apps/desktop && pnpm tauri dev    # dev mode: hot-reload window against vite dev server
pnpm tauri build                 # installers → src-tauri/target/release/bundle/
pnpm tauri icon path/to/1024.png # regenerate the full icon set
```

CI: the `desktop` job in `.github/workflows/ci.yml` builds the shell
(`tauri build --no-bundle`) on every PR so it can't silently rot.
