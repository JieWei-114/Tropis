import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => false),
  secure: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
  },
  invoke: vi.fn(),
  listen: vi.fn(),
  appListeners: [] as Array<(e: { url: string }) => void>,
  getLaunchUrl: vi.fn(),
  browserOpen: vi.fn(),
  browserClose: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: m.isNativePlatform },
}));
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn((_name: string, fn: (e: { url: string }) => void) => {
      m.appListeners.push(fn);
      return Promise.resolve({ remove: vi.fn() });
    }),
    getLaunchUrl: m.getLaunchUrl,
  },
}));
vi.mock('@capacitor/browser', () => ({
  Browser: { open: m.browserOpen, close: m.browserClose },
}));
vi.mock('@aparajita/capacitor-secure-storage', () => ({
  KeychainAccess: { afterFirstUnlockThisDeviceOnly: 3 },
  SecureStorage: m.secure,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: m.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: m.listen }));

import {
  callbackCode,
  nativeShell,
  onOAuthCallback,
  openInSystemBrowser,
  secureTokenStore,
} from '../native';

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  m.appListeners.length = 0;
  m.isNativePlatform.mockReturnValue(false);
  m.browserClose.mockResolvedValue(undefined);
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('nativeShell', () => {
  it('is null in a browser', () => {
    expect(nativeShell('http://localhost:5173')).toBeNull();
    expect(nativeShell('https://localhost')).toBeNull();
  });

  it('detects Capacitor and Tauri from a shell origin only', () => {
    m.isNativePlatform.mockReturnValue(true);
    expect(nativeShell('capacitor://localhost')).toBe('capacitor');
    expect(nativeShell('https://localhost')).toBe('capacitor');
    expect(nativeShell('http://localhost:5173')).toBeNull();

    m.isNativePlatform.mockReturnValue(false);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(nativeShell('tauri://localhost')).toBe('tauri');
    expect(nativeShell('http://tauri.localhost')).toBe('tauri');
    expect(nativeShell('http://localhost:5173')).toBeNull();
  });
});

describe('secureTokenStore', () => {
  it('keeps the token in the Keychain/Keystore, device-only and never synced', async () => {
    const store = secureTokenStore('capacitor');
    m.secure.get.mockResolvedValue('rt-1');
    await expect(store.get()).resolves.toBe('rt-1');
    expect(m.secure.get).toHaveBeenCalledWith(
      'tropis.refresh-token',
      false,
      false,
    );

    await store.set('rt-2');
    expect(m.secure.set).toHaveBeenCalledWith(
      'tropis.refresh-token',
      'rt-2',
      false,
      false,
      3,
    );

    await store.clear();
    expect(m.secure.remove).toHaveBeenCalledWith('tropis.refresh-token', false);

    m.secure.get.mockResolvedValue(null);
    await expect(store.get()).resolves.toBeNull();
  });

  it('keeps the token in the OS keyring through the desktop shell', async () => {
    const store = secureTokenStore('tauri');
    m.invoke.mockResolvedValueOnce('rt-1').mockResolvedValue(undefined);
    await expect(store.get()).resolves.toBe('rt-1');
    await store.set('rt-2');
    await store.clear();
    expect(m.invoke.mock.calls).toEqual([
      ['session_token_get'],
      ['session_token_set', { token: 'rt-2' }],
      ['session_token_clear'],
    ]);
  });
});

describe('OAuth in a native shell', () => {
  it('opens the start URL in the system browser', async () => {
    await openInSystemBrowser('capacitor', 'https://api.test/api/auth/google');
    expect(m.browserOpen).toHaveBeenCalledWith({
      url: 'https://api.test/api/auth/google',
    });
    await openInSystemBrowser('tauri', 'https://api.test/api/auth/github');
    expect(m.invoke).toHaveBeenCalledWith('open_oauth_url', {
      url: 'https://api.test/api/auth/github',
    });
  });

  it('reads the code of the callback URL only', () => {
    expect(callbackCode('tropis://auth/callback#code=abc')).toBe('abc');
    expect(callbackCode('tropis://auth/callback?x=1#code=a%2Fb')).toBe('a/b');
    expect(callbackCode('tropis://auth/callback')).toBeNull();
    expect(callbackCode('tropis://auth/callbackx#code=abc')).toBeNull();
    expect(callbackCode('tropis://auth/other#code=abc')).toBeNull();
    expect(callbackCode('https://evil.example/#code=abc')).toBeNull();
  });

  it('Capacitor: takes the launch URL and later deep links once each, closing the browser', async () => {
    m.getLaunchUrl.mockResolvedValue({
      url: 'tropis://auth/callback#code=launch',
    });
    const codes: string[] = [];
    const off = onOAuthCallback('capacitor', (c) => codes.push(c));
    await flush();

    m.appListeners[0]({ url: 'tropis://auth/callback#code=second' });
    m.appListeners[0]({ url: 'tropis://auth/callback#code=second' });
    m.appListeners[0]({ url: 'https://other.example/' });
    expect(codes).toEqual(['launch', 'second']);
    expect(m.browserClose).toHaveBeenCalledTimes(2);

    off();
    m.appListeners[0]({ url: 'tropis://auth/callback#code=late' });
    expect(codes).toEqual(['launch', 'second']);
  });

  it('Capacitor: delivers the launch URL once per process, even to a later subscriber', async () => {
    m.getLaunchUrl.mockResolvedValue({
      url: 'tropis://auth/callback#code=cold-start',
    });
    const codes: string[] = [];
    const off = onOAuthCallback('capacitor', (c) => codes.push(c));
    await flush();
    off();
    onOAuthCallback('capacitor', (c) => codes.push(c));
    await flush();
    expect(codes).toEqual(['cold-start']);
  });

  it('Tauri: listens first, then takes a callback that arrived before', async () => {
    let emit: (e: { payload: string }) => void = () => undefined;
    m.listen.mockImplementation(
      (_name: string, fn: (e: { payload: string }) => void) => {
        emit = fn;
        return Promise.resolve(() => undefined);
      },
    );
    m.invoke.mockResolvedValue('tropis://auth/callback#code=pending');
    const codes: string[] = [];
    onOAuthCallback('tauri', (c) => codes.push(c));
    await flush();

    expect(m.listen).toHaveBeenCalledWith(
      'oauth-callback',
      expect.any(Function),
    );
    expect(m.invoke).toHaveBeenCalledWith('take_oauth_callback');
    emit({ payload: 'tropis://auth/callback#code=pending' });
    emit({ payload: 'tropis://auth/callback#code=next' });
    expect(codes).toEqual(['pending', 'next']);
  });
});
