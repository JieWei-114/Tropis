import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { completeOAuthSignIn, getToken } from '../../../lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export const OAUTH_CALLBACK_PATH = '/auth/callback';

interface Props {
  onLogin: (token: string) => void;
  onCancel: () => void;
}

/** The one-time code the backend left in the URL fragment, then drops it. */
function takeCodeFromFragment(): string | null {
  const code = new URLSearchParams(window.location.hash.slice(1)).get('code');
  window.history.replaceState(
    window.history.state,
    '',
    window.location.pathname + window.location.search,
  );
  return code;
}

/**
 * Landing page of an OAuth sign-in (`/auth/callback#code=...`). The backend
 * never puts a token in the URL: the fragment carries a one-time code, which
 * never reaches a server log or a Referer, and is traded here, once, for the
 * token pair.
 */
export function OAuthCallback({ onLogin, onCancel }: Props) {
  const { t } = useTranslation();
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const code = takeCodeFromFragment();
    if (!code) {
      setError(t('auth.oauth.missingCode'));
      return;
    }
    completeOAuthSignIn(code)
      .then(() => {
        const token = getToken();
        if (token) onLogin(token);
        else setError(t('auth.oauth.failed'));
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : t('auth.oauth.failed')),
      );
  }, [onLogin, t]);

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="flex w-full max-w-sm flex-col gap-4 p-6">
        {error ? (
          <>
            <p
              role="alert"
              data-testid="oauth-error"
              className="text-sm text-danger"
            >
              {error}
            </p>
            <Button type="button" onClick={onCancel}>
              {t('auth.oauth.backToSignIn')}
            </Button>
          </>
        ) : (
          <p role="status" className="text-sm text-muted">
            {t('auth.oauth.signingIn')}
          </p>
        )}
      </Card>
    </div>
  );
}
