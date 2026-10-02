/**
 * Native-shell session plumbing: which shell the console runs in, where the
 * refresh token lives there (iOS Keychain / Android Keystore through the
 * secure storage plugin, the desktop OS keyring through the Tauri shell's
 * commands), how an OAuth sign-in leaves for the system browser and how its
 * custom-scheme callback comes back.
 *
 * A shell counts as native only when the page is served from a shell origin
 * (NATIVE_SESSION_ORIGINS): `pnpm tauri dev` and Capacitor live reload load
 * the Vite dev server, whose origin is a web origin, and keep the cookie flow.
 */

import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import {
  KeychainAccess,
  SecureStorage,
} from '@aparajita/capacitor-secure-storage';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { SecureTokenStore } from '@tropis/sdk';
import { NATIVE_SESSION_ORIGINS } from '@tropis/shared';

export type NativeShell = 'capacitor' | 'tauri';

const REFRESH_TOKEN_KEY = 'tropis.refresh-token';
const CALLBACK_PREFIX = 'tropis://auth/callback';
const TAURI_CALLBACK_EVENT = 'oauth-callback';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** The native shell the console runs in, or null in a browser. */
export function nativeShell(
  origin: string = globalThis.location?.origin ?? '',
): NativeShell | null {
  if (!(NATIVE_SESSION_ORIGINS as readonly string[]).includes(origin)) {
    return null;
  }
  if (Capacitor.isNativePlatform()) return 'capacitor';
  if (isTauri()) return 'tauri';
  return null;
}

/** The OS secure store of a shell, as the SDK's SecureTokenStore. */
export function secureTokenStore(shell: NativeShell): SecureTokenStore {
  if (shell === 'tauri') {
    return {
      get: async () =>
        (await invoke<string | null>('session_token_get')) ?? null,
      set: (token) => invoke('session_token_set', { token }),
      clear: () => invoke('session_token_clear'),
    };
  }
  return {
    async get() {
      const value = await SecureStorage.get(REFRESH_TOKEN_KEY, false, false);
      return typeof value === 'string' && value ? value : null;
    },
    set: (token) =>
      SecureStorage.set(
        REFRESH_TOKEN_KEY,
        token,
        false,
        false,
        KeychainAccess.afterFirstUnlockThisDeviceOnly,
      ),
    async clear() {
      await SecureStorage.remove(REFRESH_TOKEN_KEY, false);
    },
  };
}

/** Opens an OAuth start URL in the system browser. */
export async function openInSystemBrowser(
  shell: NativeShell,
  url: string,
): Promise<void> {
  if (shell === 'tauri') {
    await invoke('open_oauth_url', { url });
    return;
  }
  await Browser.open({ url });
}

/** The one-time code of a `tropis://auth/callback#code=...` URL. */
export function callbackCode(url: string): string | null {
  if (!url.startsWith(CALLBACK_PREFIX)) return null;
  const rest = url.slice(CALLBACK_PREFIX.length);
  if (rest && !rest.startsWith('#') && !rest.startsWith('?')) return null;
  const hash = rest.indexOf('#');
  if (hash < 0) return null;
  return new URLSearchParams(rest.slice(hash + 1)).get('code') || null;
}

/**
 * Calls `onCode` with the code of every OAuth callback deep link, including
 * the one that launched the app. Returns the unsubscribe.
 */
// The launch URL stays the same for the life of the process, so it is
// delivered once per process, not once per subscription.
const deliveredLaunchUrls = new Set<string>();

export function onOAuthCallback(
  shell: NativeShell,
  onCode: (code: string) => void,
): () => void {
  let seen = '';
  let active = true;
  const handle = (url: string | null | undefined) => {
    if (!active || !url || url === seen) return;
    const code = callbackCode(url);
    if (!code) return;
    seen = url;
    onCode(code);
  };

  if (shell === 'tauri') {
    const unlisten = listen<string>(TAURI_CALLBACK_EVENT, (e) =>
      handle(e.payload),
    );
    void unlisten
      .then(() => invoke<string | null>('take_oauth_callback'))
      .then(handle)
      .catch(() => undefined);
    return () => {
      active = false;
      void unlisten.then((off) => off()).catch(() => undefined);
    };
  }

  const listener = App.addListener('appUrlOpen', ({ url }) => {
    if (callbackCode(url)) void Browser.close().catch(() => undefined);
    handle(url);
  });
  void App.getLaunchUrl()
    .then((launch) => {
      const url = launch?.url;
      if (!url || deliveredLaunchUrls.has(url)) return;
      deliveredLaunchUrls.add(url);
      handle(url);
    })
    .catch(() => undefined);
  return () => {
    active = false;
    void listener.then((l) => l.remove()).catch(() => undefined);
  };
}
