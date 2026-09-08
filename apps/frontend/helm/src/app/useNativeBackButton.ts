import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { useLocation, useNavigate } from 'react-router';

/**
 * Makes Android's back gesture / button navigate the SPA instead of killing
 * the app.
 *
 * Android's back gesture is routed through the `@capacitor/app` plugin; with no
 * listener registered the default Activity behaviour applies and the activity
 * finishes, closing the app instead of navigating back a route.
 *
 * At the root route there is nothing to go back to, so the app exits — which
 * is what Android users expect there.
 *
 * No-op on the web and in the desktop shell: `isNativePlatform()` is false, so
 * nothing is registered and the browser keeps its own history behaviour.
 */
export function useNativeBackButton(): void {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    // The listener registers asynchronously, so keep the handle to remove the
    // right one — re-running this effect must not leave a stale listener that
    // navigates with a captured, outdated location.
    const handle = App.addListener('backButton', ({ canGoBack }) => {
      const atRoot =
        location.pathname === '/' || location.pathname === '/analytics';
      if (canGoBack && !atRoot) {
        void navigate(-1);
      } else {
        void App.exitApp();
      }
    });

    return () => {
      void handle.then((listener) => listener.remove());
    };
  }, [navigate, location.pathname]);
}
