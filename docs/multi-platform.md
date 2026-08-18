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
cd apps/desktop && pnpm tauri build      # runs `pnpm --filter @tropis/helm build` first
```

Artifacts land in `apps/desktop/src-tauri/target/release/bundle/`
(macOS: `macos/Tropis.app` + `dmg/Tropis_*.dmg`). Local macOS builds are
unsigned — fine for local use; distribution needs codesign + notarization.
Dev mode against the Vite dev server: `pnpm tauri dev` (add
`build.devUrl`/`beforeDevCommand` in `src-tauri/tauri.conf.json` if wanted).

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
