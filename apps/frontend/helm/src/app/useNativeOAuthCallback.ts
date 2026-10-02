import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { OAUTH_CALLBACK_PATH } from '../features/auth';
import { onNativeOAuthCallback } from '../lib/api';

/**
 * Native shells: an OAuth sign-in finishes in the system browser, which
 * hands `tropis://auth/callback#code=...` back to the app. This routes it to
 * the in-app callback page, which trades the code like the web flow does.
 * No-op in a browser.
 */
export function useNativeOAuthCallback(): void {
  const navigate = useNavigate();
  // useNavigate changes identity on every route change under BrowserRouter;
  // subscribing once keeps a route change from re-delivering a callback.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(
    () =>
      onNativeOAuthCallback((code) => {
        void navigateRef.current(
          {
            pathname: OAUTH_CALLBACK_PATH,
            hash: `code=${encodeURIComponent(code)}`,
          },
          { replace: true },
        );
      }),
    [],
  );
}
