import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../lib/api', () => ({
  login: vi.fn(),
  createUser: vi.fn(),
  getToken: vi.fn(() => 'token-abc'),
}));

import { LoginForm } from '../components/LoginForm';
import * as grpcWeb from '../../../lib/api';

const loginMock = grpcWeb.login as Mock;
const createUserMock = grpcWeb.createUser as Mock;

describe('LoginForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders login mode by default and calls login on submit', async () => {
    loginMock.mockResolvedValue(undefined);
    const user = userEvent.setup();
    const onLogin = vi.fn();

    render(<LoginForm onLogin={onLogin} />);

    await user.type(screen.getByTestId('login-email'), 'alice@example.com');
    await user.type(screen.getByTestId('login-password'), 'secret123');
    const submitButton = screen
      .getAllByRole('button', { name: /sign in/i })
      .find((button) => button.getAttribute('type') === 'submit');
    expect(submitButton).toBeDefined();
    await user.click(submitButton as HTMLElement);

    expect(loginMock).toHaveBeenCalledWith('alice@example.com', 'secret123');
    expect(onLogin).toHaveBeenCalledWith('token-abc');
  });

  it('switches to register mode and shows extra fields', async () => {
    const ui = userEvent.setup();
    render(<LoginForm onLogin={vi.fn()} />);

    await ui.click(screen.getByRole('button', { name: /register/i }));

    expect(screen.getByTestId('login-name')).toBeInTheDocument();
    expect(screen.getByTestId('login-age')).toBeInTheDocument();
  });

  it('shows inline zod errors and skips the API call on invalid submit', async () => {
    const ui = userEvent.setup();
    render(<LoginForm onLogin={vi.fn()} />);

    await ui.type(screen.getByTestId('login-email'), 'not-an-email');
    await ui.type(screen.getByTestId('login-password'), 'shrt');
    const submitButton = screen
      .getAllByRole('button', { name: /sign in/i })
      .find((b) => b.getAttribute('type') === 'submit');
    await ui.click(submitButton as HTMLElement);

    // zod resolver blocks submit and surfaces accessible inline errors
    expect(
      await screen.findByText(/enter a valid email address/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/password must be at least 8 characters/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId('login-email')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByTestId('login-email')).toHaveAttribute(
      'aria-describedby',
      'login-email-error',
    );
    expect(loginMock).not.toHaveBeenCalled();
  });

  it('calls createUser then login on register submit and fires onLogin', async () => {
    createUserMock.mockResolvedValue(undefined);
    loginMock.mockResolvedValue(undefined);
    const ui = userEvent.setup();
    const onLogin = vi.fn();
    render(<LoginForm onLogin={onLogin} />);

    await ui.click(screen.getByRole('button', { name: /register/i }));

    await ui.type(screen.getByTestId('login-name'), 'Alice');
    await ui.type(screen.getByTestId('login-email'), 'alice@example.com');
    await ui.type(screen.getByTestId('login-password'), 'secret123');

    const submitButton = screen
      .getAllByRole('button', { name: /create account/i })
      .find((b) => b.getAttribute('type') === 'submit');
    await ui.click(submitButton as HTMLElement);

    expect(createUserMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Alice',
        email: 'alice@example.com',
        password: 'secret123',
      }),
    );
    expect(loginMock).toHaveBeenCalledWith('alice@example.com', 'secret123');
    expect(onLogin).toHaveBeenCalledWith('token-abc');
  });

  it('shows error when createUser fails during registration', async () => {
    createUserMock.mockRejectedValue(new Error('Email already taken'));
    const ui = userEvent.setup();
    render(<LoginForm onLogin={vi.fn()} />);

    await ui.click(screen.getByRole('button', { name: /register/i }));

    await ui.type(screen.getByTestId('login-name'), 'Bob');
    await ui.type(screen.getByTestId('login-email'), 'bob@example.com');
    await ui.type(screen.getByTestId('login-password'), 'pass1234');

    const submitButton = screen
      .getAllByRole('button', { name: /create account/i })
      .find((b) => b.getAttribute('type') === 'submit');
    await ui.click(submitButton as HTMLElement);

    expect(await screen.findByText(/email already taken/i)).toBeInTheDocument();
    expect(loginMock).not.toHaveBeenCalled();
  });

  it('shows an error message when login fails', async () => {
    loginMock.mockRejectedValue(new Error('Invalid credentials'));
    const user = userEvent.setup();
    render(<LoginForm onLogin={vi.fn()} />);

    await user.type(screen.getByTestId('login-email'), 'bob@example.com');
    await user.type(screen.getByTestId('login-password'), 'wrongpass');
    const submitButton = screen
      .getAllByRole('button', { name: /sign in/i })
      .find((button) => button.getAttribute('type') === 'submit');
    expect(submitButton).toBeDefined();
    await user.click(submitButton as HTMLElement);

    expect(await screen.findByText(/invalid credentials/i)).toBeInTheDocument();
  });
});
