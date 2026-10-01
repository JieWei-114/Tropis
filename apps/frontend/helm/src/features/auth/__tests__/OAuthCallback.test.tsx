import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../lib/api', () => ({
  completeOAuthSignIn: vi.fn(),
  getToken: vi.fn(() => 'token-abc'),
}));

import { OAuthCallback } from '../components/OAuthCallback';
import * as api from '../../../lib/api';

const exchangeMock = api.completeOAuthSignIn as Mock;

describe('OAuthCallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('trades the fragment code once, drops it from the URL and signs in', async () => {
    window.history.pushState(null, '', '/auth/callback#code=one-time');
    exchangeMock.mockResolvedValue(undefined);
    const onLogin = vi.fn();

    const { rerender } = render(
      <OAuthCallback onLogin={onLogin} onCancel={vi.fn()} />,
    );
    rerender(<OAuthCallback onLogin={onLogin} onCancel={vi.fn()} />);

    await waitFor(() => expect(onLogin).toHaveBeenCalledWith('token-abc'));
    expect(exchangeMock).toHaveBeenCalledTimes(1);
    expect(exchangeMock).toHaveBeenCalledWith('one-time');
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('');
  });

  it('never reads a token from the query string', async () => {
    window.history.pushState(null, '', '/auth/callback?token=leaked');
    const onLogin = vi.fn();

    render(<OAuthCallback onLogin={onLogin} onCancel={vi.fn()} />);

    expect(await screen.findByTestId('oauth-error')).toBeInTheDocument();
    expect(exchangeMock).not.toHaveBeenCalled();
    expect(onLogin).not.toHaveBeenCalled();
  });

  it('shows the error of a rejected code and offers the way back', async () => {
    window.history.pushState(null, '', '/auth/callback#code=stale');
    exchangeMock.mockRejectedValue(
      new Error('The sign-in code is invalid or has expired.'),
    );
    const onCancel = vi.fn();

    render(<OAuthCallback onLogin={vi.fn()} onCancel={onCancel} />);

    expect(await screen.findByTestId('oauth-error')).toHaveTextContent(
      'The sign-in code is invalid or has expired.',
    );
    await userEvent.setup().click(screen.getByRole('button'));
    expect(onCancel).toHaveBeenCalled();
  });
});
