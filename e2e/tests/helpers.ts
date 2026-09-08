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
 * Managing the user directory (list, edit, delete anyone) is admin-only, and
 * self-registration deliberately grants only `editor` — so a freshly
 * registered account cannot drive those flows. Specs that exercise the
 * directory sign in as this account instead; specs that exercise registration
 * itself still register.
 *
 * The `make test-e2e` target runs `make seed` and then
 * `make promote-admin EMAIL=admin@example.com`.
 */
const ADMIN = {
  email: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com',
  password: process.env.E2E_ADMIN_PASSWORD ?? 'Password123!',
};

/**
 * The admin JWT, reused across tests.
 *
 * POST /auth/login is throttled to 10 attempts per minute per IP (a
 * deliberate security default), and the suite has more tests than that. Each
 * test getting its own UI login therefore fails the whole run with 429s once
 * the suite grows. One real sign-in per process, replayed into localStorage
 * afterwards, keeps the suite independent of that limit — and much faster.
 */
let adminToken: string | null = null;

/** Signs in as the promoted admin and waits for the authenticated UI. */
export async function loginAsAdmin(page: Page): Promise<void> {
  if (adminToken) {
    await page.addInitScript(
      (t: string) => localStorage.setItem('token', t),
      adminToken,
    );
    await page.goto('/users');
    await expectAuthenticated(page);
    return;
  }

  await login(page, ADMIN.email, ADMIN.password);
  await expectAuthenticated(page);
  adminToken = await page.evaluate(() => localStorage.getItem('token'));
  if (!adminToken) throw new Error('admin sign-in did not store a token');
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
 * Signs in once for the whole spec file and replays the JWT into localStorage
 * on every subsequent page — the app is fully auth-gated (an unauthenticated
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
