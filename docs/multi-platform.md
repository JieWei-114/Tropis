# Multi-platform distribution guide

The helm web app (`apps/frontend/helm/`) — one of two frontends (harbor is the public Next.js site) — ships to four channels. The PWA is the default;
the native shells (Capacitor for Android/iOS, Tauri for desktop) are
pre-wired and simply wrap the **built** web app from `apps/frontend/helm/dist/`.
Decision record: [tech-decisions.md](tech-decisions.md) → "Multi-platform
distribution".

## How each channel works

| Channel   | Shell                                                                                     | What ships                    | Updates               |
| --------- | ----------------------------------------------------------------------------------------- | ----------------------------- | --------------------- |
| Web / PWA | none (vite-plugin-pwa)                                                                    | `dist/` on any static host    | instant               |
| Android   | Capacitor (`apps/frontend/helm/android/`, committed Gradle project)                       | APK/AAB embedding `dist/`     | store review          |
| iOS       | Capacitor (`apps/frontend/helm/ios/`, scaffolded — needs Xcode for `pod install` + build) | IPA embedding `dist/`         | store review          |
| Desktop   | Tauri v2 (`apps/desktop/`, own Rust crate in `src-tauri/`)                                | .app/.dmg/.exe/.deb, ~5–15 MB | installer per release |

## Env / endpoints for device builds (read this first)

The shells load the **built** web app, so API endpoints are baked in at
`pnpm build` time from Vite env vars (`apps/frontend/helm/.env`, consumed by
`src/lib/env.ts`):

```
VITE_API_BASE_URL / VITE_WS_URL / VITE_GRPC_WEB_URL
```

`localhost` inside a phone or emulator is the **device**, not your machine.
For device testing set these to a backend reachable from the device — your
machine's LAN IP, e.g.:

```
VITE_API_BASE_URL=http://192.168.1.20:3100
VITE_WS_URL=http://192.168.1.20:3100
VITE_GRPC_WEB_URL=http://192.168.1.20:8090
```

then rebuild (`pnpm --filter @tropis/helm build`) and re-sync/re-bundle.
(Android emulator only: `10.0.2.2` maps to the host.)

## Prerequisites per platform

| Platform | Needs                                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PWA      | Node 22+, pnpm (already required)                                                                                                                                   |
| Android  | Android Studio + Android SDK (SDK 35+), JDK 21                                                                                                                      |
| iOS      | macOS + full Xcode (not just CommandLineTools) + CocoaPods (`brew install cocoapods`)                                                                               |
| Desktop  | Rust toolchain (rustup); Linux additionally: `libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev` |

## Build commands

### PWA

```bash
pnpm --filter @tropis/helm build     # dist/ incl. manifest + service worker
```

### Android (Capacitor)

```bash
pnpm --filter @tropis/helm build
cd apps/frontend/helm
pnpm cap:sync                  # copies dist/ into android/app/src/main/assets/public
pnpm cap:android               # opens Android Studio → Run / Build > Generate Signed Bundle
# or headless (needs SDK): cd android && ./gradlew assembleDebug
```

Or from the repo root: `make android` (build + sync).

### iOS (Capacitor) — scaffolded; only Xcode missing

The `ios/` platform IS generated and committed (`apps/frontend/helm/ios/`:
xcodeproj, xcworkspace, Podfile, plugin specs) and CocoaPods is installed.
The only step that couldn't run on the setup machine is `pod install`,
which requires full Xcode (xcodebuild). To finish:

```bash
# 1. Install Xcode from the App Store (needs your Apple ID — can't be automated)
sudo xcode-select --switch /Applications/Xcode.app    # point away from CommandLineTools
sudo xcodebuild -license accept
# 2. Finish the pods + sync
cd apps/frontend/helm
pnpm --filter @tropis/helm build
cd ios/App && pod install && cd ../..
npx cap sync ios
npx cap open ios               # Xcode → set signing team → Run / Archive
```

### Desktop (Tauri)

```bash
make desktop
# or:
cd apps/desktop && pnpm run bundle       # installers; runs the helm build first
cd apps/desktop && pnpm run build        # binary only, no OS installer tooling needed
```

Artifacts land in `apps/desktop/src-tauri/target/release/bundle/`
(macOS: `macos/Tropis.app` + `dmg/Tropis_*.dmg`). Local macOS builds are
unsigned — fine for local use; distribution needs codesign + notarization.
Dev mode against the Vite dev server: `pnpm tauri dev` (add
`build.devUrl`/`beforeDevCommand` in `src-tauri/tauri.conf.json` if wanted).

## Known gaps to close before shipping a native build

**1. The desktop shell runs with no Content-Security-Policy.**
`apps/desktop/src-tauri/tauri.conf.json` sets `app.security.csp` to `null`, so
the webview enforces nothing. It is not hardcoded because the shell loads the
**built** web app, whose API endpoints are baked in from `VITE_*` at build time
(see the section above) — any `connect-src` written into the config would be
wrong for every deployment except the one that authored it. Generate it at
package time from the same env instead, along the lines of:

```
default-src 'self';
connect-src 'self' <VITE_API_BASE_URL> <VITE_GRPC_WEB_URL> <VITE_WS_URL> ws: wss:;
img-src 'self' data:;
style-src 'self' 'unsafe-inline'
```

`'unsafe-inline'` for styles is currently required; drop it once styles are
fully extracted.

**2. CORS must list the native origins.** The shells serve their bundle from a
custom scheme, not from a network origin, so they are _not_ covered by
`CORS_ORIGIN`. Those origins are constants and are already allowed by both the
backend (`apps/backend/src/config/cors.constants.ts`) and Envoy
(`infra/envoy/envoy.yaml`, `infra/k8s/base/envoy/envoy.yaml`):

| Client                           | Origin                   |
| -------------------------------- | ------------------------ |
| Desktop (macOS, Linux)           | `tauri://localhost`      |
| Desktop (Windows)                | `http://tauri.localhost` |
| iOS                              | `capacitor://localhost`  |
| Android (default scheme)         | `http://localhost`       |
| Android (`androidScheme: https`) | `https://localhost`      |

If you put a different gateway in front of the API, add the same five entries
there. An allow-list that omits them lets each app build, launch and show the
login screen, and then fail at sign-in with a CORS error.

**3. Neither mobile app has been run on a device or simulator** in this
repository's history, and the desktop shell's window has not been visually
verified. `cap sync` and `tauri build` succeed; that is not the same as the
apps working.

## Store submission (pointers)

- **Play Store**: signed AAB via Android Studio → Play Console (one-time $25) — https://developer.android.com/distribute
- **App Store**: Xcode Archive → App Store Connect (Apple Developer $99/yr) — https://developer.apple.com/app-store/submissions/
- **macOS outside the App Store**: Developer ID codesign + `xcrun notarytool` — https://tauri.app/distribute/sign/macos/
- **Windows/Linux**: MSI/NSIS + Authenticode; .deb/.AppImage need no store — https://tauri.app/distribute/

## Icon / branding replacement checklist

- [ ] Replace `apps/frontend/helm/public/pwa-192x192.png`, `pwa-512x512.png`, `apple-touch-icon.png`, `vite.svg`; update names/colors in the PWA manifest (`vite.config.ts`) and `index.html` `theme-color`
- [ ] Regenerate all Tauri + Android/iOS icons from one 1024px source: `cd apps/desktop && npx tauri icon path/to/icon.png` (writes `src-tauri/icons/` **and** Android mipmaps/iOS sets when platforms exist)
- [ ] Replace `apps/frontend/helm/android/app/src/main/res/mipmap-*` launcher icons (Android Studio: Image Asset Studio) and splash if added
- [ ] Change the placeholder ids: `appId` in `apps/frontend/helm/capacitor.config.ts`, `identifier` in `apps/desktop/src-tauri/tauri.conf.json`, `applicationId`/`namespace` in `apps/frontend/helm/android/app/build.gradle`
- [ ] `appName` (capacitor.config.ts), `productName` + window `title` (tauri.conf.json), `app_name` in `android/app/src/main/res/values/strings.xml`
