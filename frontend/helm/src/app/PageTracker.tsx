import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { tracker } from '../lib/tracking';

/** Fires a `page.view` tracking event on every route change. Renders nothing. */
export function PageTracker() {
  const { pathname } = useLocation();

  useEffect(() => {
    tracker.page(pathname);
  }, [pathname]);

  return null;
}
