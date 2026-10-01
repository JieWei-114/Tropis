import { expect, type Page } from '@playwright/test';

/** Unique-ish suffix for test data so runs never collide. */
export function uniqueId(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export interface TestUser {
  name: string;
  email: string;
  password: string;
  age: number;
}

export function freshUser(prefix = 'e2e'): TestUser {
  const id = uniqueId();
  return {
    name: `${prefix}-${id}`,
    email: `${prefix}-${id}@example.com`,
    password: 'Password123!',
    age: 30,
  };
}

/**
 * Registers a brand-new user through the LoginForm's "Register" mode
 * (create → auto-login) and waits for the authenticated Users page UI.
 */
export async function registerAndLogin(
  page: Page,
  user: TestUser = freshUser(),
): Promise<TestUser> {
  await page.goto('/users');
  await page.getByRole('button', { name: 'Register' }).click();
  await page.getByTestId('login-name').fill(user.name);
  await page.getByTestId('login-age').fill(String(user.age));
  await page.getByTestId('login-email').fill(user.email);
  await page.getByTestId('login-password').fill(user.password);
  await page.getByRole('button', { name: 'Create account & sign in' }).click();
  await expectAuthenticated(page);
  return user;
}

/**
 * The seeded account, promoted to admin by the test harness.
 *
 * Managing the user directory (list, edit, delete anyone) and firing or
 * reading analytics need roles self-registration never grants (it grants
 * `member`) — so a freshly registered account cannot drive those flows.
 * Specs that exercise them sign in as this account instead; specs that
 * exercise registration itself still register (in tenant `dev`, which the
 * seeder registers with self sign-up on).
 *
 * The `make test-e2e` target runs `make seed`, which registers tenant `dev`
 * and makes admin@example.com its admin.
 */
const ADMIN = {
  email: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com',
  password: process.env.E2E_ADMIN_PASSWORD ?? 'Password123!',
};

/**
 * Signs in as the seeded admin through the UI and waits for the authenticated
 * UI. The session is the access token in memory plus the httpOnly refresh
 * cookie, so it cannot be replayed into storage; each test signs in for real.
 * `make test-e2e` raises RATE_LIMIT_AUTH (E2E_RATE_LIMIT_AUTH) so the suite
 * stays under the login throttle.
 */
export async function loginAsAdmin(page: Page): Promise<void> {
  await login(page, ADMIN.email, ADMIN.password);
  await expectAuthenticated(page);
}

/** Signs in an existing user through the LoginForm's "Sign in" mode. */
export async function login(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto('/users');
  await page
    .getByRole('button', { name: 'Sign in', exact: true })
    .first()
    .click();
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).last().click();
}

/** Authenticated Users page shows the "+ New User" / "Logout" actions. */
export async function expectAuthenticated(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: '+ New User' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();
}

/**
 * Signs in as the admin before each page of a spec file (the session is an
 * in-memory token plus an httpOnly cookie, so it is not replayed) — the app is fully auth-gated (an unauthenticated
 * visitor only ever sees the login screen, no nav, no pages), so
 * navigation/deep-link tests need a session before they can see anything.
 *
 * Uses the admin account because the pages under test render the user
 * directory, which is admin-only.
 */
export function sharedSession(): (page: Page) => Promise<void> {
  return (page: Page) => loginAsAdmin(page);
}

/** The sidebar WebSocket status badge — present on every authenticated page. */
export function wsBadge(page: Page) {
  return page.getByText(/^WS (live|connecting)/).first();
}
