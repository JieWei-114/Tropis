import { lazy, Suspense, useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { HelmetProvider } from 'react-helmet-async';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Navigate, NavLink } from 'react-router';
import { Toasts } from '../components/Toasts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ErrorBoundary } from './ErrorBoundary';
import { LoginForm } from '../features/auth';
import { PageTracker } from './PageTracker';
import { useNativeBackButton } from './useNativeBackButton';
import { useKeyboardAwareInputs } from './useKeyboardAwareInputs';
import { ThemeProvider, useTheme, type Theme } from './ThemeProvider';
import { tracker } from '../lib/tracking';
import { TRACKING_EVENTS } from '@tropis/shared';
import { connectWs, isConnected, type WsEvent } from '../lib/websocket';
import { useAuthStore } from '../state/zustand/authStore';
import { useToastStore } from '../state/zustand/toastStore';
import { queryClient } from '../state/tanstack/queryClient';

// Route-level code splitting — each page loads as its own chunk on first visit.
const AnalyticsPage = lazy(() =>
  import('../pages/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage })),
);
const UsersPage = lazy(() =>
  import('../pages/UsersPage').then((m) => ({ default: m.UsersPage })),
);
const StackPage = lazy(() =>
  import('../pages/StackPage').then((m) => ({ default: m.StackPage })),
);

function PageFallback() {
  const { t } = useTranslation();
  return (
    <div
      className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-[13px] text-muted"
      role="status"
      aria-live="polite"
    >
      <span
        className="h-7 w-7 animate-spinner rounded-full border-[3px] border-primary/25 border-t-primary"
        aria-hidden="true"
      />
      {t('common.loading')}
    </div>
  );
}

const THEME_OPTIONS: Theme[] = ['light', 'dark', 'system'];

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const { t } = useTranslation();
  const label = `${t(`theme.${theme}`)} — ${t('theme.choose')}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="cursor-pointer rounded-md border border-border bg-transparent px-2 py-1 text-[13px] leading-none transition-colors hover:bg-raised"
          title={label}
          aria-label={label}
        >
          {t(`theme.${theme}`)}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(v) => setTheme(v as Theme)}
        >
          {THEME_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              {t(`theme.${option}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const LANGUAGES: { code: string; label: string }[] = [
  { code: 'en', label: 'EN' },
  { code: 'zh', label: '中文' },
];

function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const current =
    LANGUAGES.find((l) => i18n.resolvedLanguage?.startsWith(l.code)) ??
    LANGUAGES[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="cursor-pointer rounded-md border border-border bg-transparent px-2 py-1 text-[13px] leading-none transition-colors hover:bg-raised"
          title={t('nav.language')}
          aria-label={t('nav.language')}
        >
          {current.label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={current.code}
          onValueChange={(code) => {
            void i18n.changeLanguage(code); // persisted to localStorage by the detector
          }}
        >
          {LANGUAGES.map((l) => (
            <DropdownMenuRadioItem key={l.code} value={l.code}>
              {l.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function stringField(
  data: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = data[key];
  return typeof v === 'string' ? v : undefined;
}

function AppInner() {
  // Android back gesture -> SPA history. No-op on web and desktop.
  useNativeBackButton();
  // Keep a focused field above the soft keyboard. No-op without one.
  useKeyboardAwareInputs();
  const { t } = useTranslation();
  const authed = useAuthStore((s) => s.authed);
  const login = useAuthStore((s) => s.login);
  const logout = useAuthStore((s) => s.logout);
  const toasts = useToastStore((s) => s.toasts);
  const push = useToastStore((s) => s.push);
  const dismiss = useToastStore((s) => s.dismiss);

  const [wsOn, setWsOn] = useState(false);

  const handleWsEvent = useCallback(
    (e: WsEvent) => {
      if (e.name === 'user.created') {
        const name = stringField(e.data, 'name') ?? t('toasts.someone');
        push({
          type: 'success',
          title: t('toasts.newUserTitle'),
          message: t('toasts.newUserJoined', { name }),
        });
      } else if (e.name === 'user.updated') {
        const name = stringField(e.data, 'name') ?? t('toasts.aUser');
        push({
          type: 'info',
          title: t('toasts.userUpdatedTitle'),
          message: t('toasts.userUpdatedBody', { name }),
        });
      } else if (e.name === 'notification') {
        push({
          type: 'info',
          title: t('toasts.notification'),
          message: stringField(e.data, 'message') ?? '',
        });
      }
    },
    [push, t],
  );

  useEffect(() => {
    if (!authed) {
      setWsOn(false);
      return;
    }
    const disconnect = connectWs(handleWsEvent);
    const t = setTimeout(() => setWsOn(isConnected()), 1000);
    return () => {
      clearTimeout(t);
      disconnect();
      setWsOn(false);
    };
  }, [authed, handleWsEvent]);

  // Auth gate: an unauthenticated visitor only ever sees the login screen —
  // no nav, no pages. Everything below renders only once signed in.
  if (!authed) {
    return (
      <main className="min-h-dvh">
        <LoginForm onLogin={login} />
      </main>
    );
  }

  const navItem = ({ isActive }: { isActive: boolean }) =>
    `relative flex items-center rounded-lg px-3 py-2 text-[13.5px] transition-colors ${
      isActive
        ? 'bg-primary/12 font-semibold text-primary-soft'
        : 'font-medium text-muted hover:bg-surface hover:text-body'
    }`;

  const navList = (onNavigate?: () => void) =>
    NAV_LINKS.map(({ to, labelKey }) => (
      <NavLink
        key={to}
        to={to}
        onClick={() => {
          tracker.track(TRACKING_EVENTS.NAV_CLICK.name, {
            to,
            label: t(labelKey),
          });
          onNavigate?.();
        }}
        className={navItem}
      >
        {({ isActive }: { isActive: boolean }) => (
          <>
            {isActive && (
              <span className="absolute top-1/2 left-0 h-4 w-[3px] -translate-y-1/2 rounded-full bg-primary" />
            )}
            {t(labelKey)}
          </>
        )}
      </NavLink>
    ));

  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[200] focus:rounded-md focus:bg-primary focus:px-3 focus:py-1.5 focus:text-[13px] focus:text-white"
      >
        {t('nav.skipToContent')}
      </a>

      {/*
        Column on mobile, row from md up. The sidebar (md+), the mobile top bar
        and <main> are siblings in this container, so a row layout gives the
        full-width mobile header the whole line and leaves <main> with no width.
      */}
      <div className="flex min-h-dvh flex-col md:flex-row">
        {/* ── Sidebar (desktop) ── */}
        <aside className="sticky top-0 hidden h-dvh w-[232px] shrink-0 flex-col gap-1 border-r border-border bg-card px-3 py-5 md:flex">
          <div className="flex items-center gap-2 px-2 pb-5 text-[16px] font-bold tracking-[-0.3px] text-heading">
            <span className="h-5 w-5 rounded-[6px] bg-primary" />
            Tropis
          </div>
          <nav className="flex flex-col gap-1">{navList()}</nav>

          <div className="mt-auto flex flex-col gap-3 border-t border-border-soft pt-4">
            <span
              className={`inline-flex items-center gap-[6px] self-start rounded-full border px-2.5 py-[3px] text-[11px] font-semibold ${
                wsOn
                  ? 'border-success/25 bg-success/10 text-success'
                  : 'border-border bg-surface text-muted'
              }`}
            >
              <span className="h-1.5 w-1.5 animate-blink rounded-full bg-current" />
              WS {wsOn ? t('nav.wsLive') : t('nav.wsConnecting')}
            </span>
            <div className="flex items-center gap-2 px-0.5">
              <LanguageSwitcher />
              <ThemeToggle />
            </div>
            <button
              onClick={() => void logout()}
              className="rounded-lg border border-border px-3 py-1.5 text-left text-[13px] text-muted transition-colors hover:bg-surface hover:text-body"
            >
              {t('users.logout')}
            </button>
          </div>
        </aside>

        {/* ── Mobile top bar ── */}
        {/*
          Two rows on purpose. The nav needs its own row because sharing one
          with the brand and the controls leaves the scroller about a tab wide,
          hiding every destination but the first behind a horizontal swipe.
        */}
        <header className="sticky top-0 z-[100] flex w-full flex-col gap-1.5 border-b border-border bg-background/85 px-3 py-2.5 backdrop-blur-md md:hidden">
          <div className="flex items-center gap-2">
            <span className="flex shrink-0 items-center gap-2 text-[15px] font-bold text-heading">
              <span className="h-4 w-4 rounded-[5px] bg-primary" />
              Tropis
            </span>
            <span
              className={`ml-auto inline-flex shrink-0 items-center gap-[5px] rounded-full border px-2 py-[2px] text-[10px] font-semibold ${
                wsOn
                  ? 'border-success/25 bg-success/10 text-success'
                  : 'border-border bg-surface text-muted'
              }`}
            >
              <span className="h-1.5 w-1.5 animate-blink rounded-full bg-current" />
              WS
            </span>
            <LanguageSwitcher />
            <ThemeToggle />
            <button
              onClick={() => void logout()}
              className="cursor-pointer rounded-md border border-border bg-transparent px-2 py-1 text-[12px] text-muted transition-colors hover:bg-surface hover:text-body"
            >
              {t('users.logout')}
            </button>
          </div>
          <nav className="scrollbar-none flex min-w-0 gap-1 overflow-x-auto">
            {navList()}
          </nav>
        </header>

        <main id="main-content" className="min-w-0 flex-1">
          <ErrorBoundary>
            <Suspense fallback={<PageFallback />}>
              <Routes>
                <Route
                  path="/"
                  element={<Navigate to="/analytics" replace />}
                />
                <Route path="/analytics" element={<AnalyticsPage />} />
                <Route path="/users" element={<UsersPage />} />
                <Route path="/stack" element={<StackPage />} />
                <Route
                  path="/behavior"
                  element={<Navigate to="/analytics" replace />}
                />
                <Route
                  path="*"
                  element={<Navigate to="/analytics" replace />}
                />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </>
  );
}

export default function App() {
  return (
    <HelmetProvider>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <BrowserRouter>
            <PageTracker />
            <AppInner />
          </BrowserRouter>
        </ThemeProvider>
      </QueryClientProvider>
    </HelmetProvider>
  );
}

const NAV_LINKS: { to: string; labelKey: string }[] = [
  { to: '/analytics', labelKey: 'nav.analytics' },
  { to: '/users', labelKey: 'nav.users' },
  { to: '/stack', labelKey: 'nav.stack' },
];
