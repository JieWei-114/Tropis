import { lazy, Suspense, useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { HelmetProvider } from 'react-helmet-async';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  NavLink,
} from 'react-router-dom';
import { Toasts } from '../components/Toasts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ErrorBoundary } from './ErrorBoundary';
import { PageTracker } from './PageTracker';
import { ThemeProvider, useTheme, type Theme } from './ThemeProvider';
import { tracker } from '../lib/tracking';
import { TRACKING_EVENTS } from '@tropis/shared';
import { connectWs, isConnected, type WsEvent } from '../lib/websocket';
import { useAuthStore } from '../state/zustand/authStore';
import { useToastStore } from '../state/zustand/toastStore';
import { queryClient } from '../state/tanstack/queryClient';

// Route-level code splitting — each page loads as its own chunk on first visit.
const Dashboard = lazy(() =>
  import('../pages/Dashboard').then((m) => ({ default: m.Dashboard })),
);
const UsersPage = lazy(() =>
  import('../pages/UsersPage').then((m) => ({ default: m.UsersPage })),
);
const StackPage = lazy(() =>
  import('../pages/StackPage').then((m) => ({ default: m.StackPage })),
);
const StateDemoPage = lazy(() =>
  import('../pages/StateDemoPage').then((m) => ({ default: m.StateDemoPage })),
);
const BehaviorPage = lazy(() =>
  import('../pages/BehaviorPage').then((m) => ({ default: m.BehaviorPage })),
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

const THEME_ICONS: Record<Theme, string> = {
  light: '☀️',
  dark: '🌙',
  system: '🖥️',
};
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
          {THEME_ICONS[theme]}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(v) => setTheme(v as Theme)}
        >
          {THEME_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              {THEME_ICONS[option]} {t(`theme.${option}`)}
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
          🌐 {current.label}
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

  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[200] focus:rounded-md focus:bg-primary focus:px-3 focus:py-1.5 focus:text-[13px] focus:text-white"
      >
        {t('nav.skipToContent')}
      </a>
      <nav className="sticky top-0 z-[100] border-b border-border bg-surface">
        <div className="mx-auto flex h-[52px] max-w-[1200px] items-center gap-8 px-6 max-md:gap-3 max-md:px-3">
          <span className="text-[15px] font-bold tracking-[-0.3px] text-heading">
            ⚡ Tropis
          </span>
          <div className="flex gap-1 max-md:scrollbar-none max-md:flex-1 max-md:overflow-x-auto">
            {NAV_LINKS.map(({ to, labelKey }) => (
              <NavLink
                key={to}
                to={to}
                onClick={() =>
                  tracker.track(TRACKING_EVENTS.NAV_CLICK.name, {
                    to,
                    label: t(labelKey),
                  })
                }
                className={({ isActive }: { isActive: boolean }) =>
                  `app-tab rounded-md px-4 py-1.5 text-[13px] font-medium transition-colors max-md:px-3 max-md:whitespace-nowrap ${
                    isActive
                      ? 'app-tab--active bg-raised text-heading'
                      : 'text-muted hover:bg-raised hover:text-body'
                  }`
                }
              >
                {t(labelKey)}
              </NavLink>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2.5">
            {authed && (
              <span
                className={`ws-badge inline-flex items-center gap-[5px] rounded-full border px-2.5 py-[3px] text-[11px] font-semibold max-md:hidden ${
                  wsOn
                    ? 'border-success/25 bg-success/10 text-success'
                    : 'border-border bg-card text-muted'
                }`}
              >
                <span className="h-1.5 w-1.5 animate-blink rounded-full bg-current" />{' '}
                WS {wsOn ? t('nav.wsLive') : t('nav.wsConnecting')}
              </span>
            )}
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </div>
      </nav>

      <main id="main-content" className="min-h-[calc(100vh-52px)]">
        <ErrorBoundary>
          <Suspense fallback={<PageFallback />}>
            <Routes>
              <Route path="/" element={<Navigate to="/analytics" replace />} />
              <Route path="/analytics" element={<Dashboard />} />
              <Route
                path="/users"
                element={
                  <UsersPage
                    authed={authed}
                    onLogin={login}
                    onLogout={logout}
                  />
                }
              />
              <Route path="/stack" element={<StackPage />} />
              <Route path="/state-demo" element={<StateDemoPage />} />
              <Route path="/behavior" element={<BehaviorPage />} />
              <Route path="*" element={<Navigate to="/analytics" replace />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </main>

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
  { to: '/state-demo', labelKey: 'nav.state' },
  { to: '/behavior', labelKey: 'nav.behavior' },
];
