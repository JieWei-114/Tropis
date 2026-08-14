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
export async function registerAndLogin(page: Page, user: TestUser = freshUser()): Promise<TestUser> {
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

/** Signs in an existing user through the LoginForm's "Sign in" mode. */
export async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/users');
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click();
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).last().click();
}

/** Authenticated Users page shows the "+ New User" / "Logout" actions. */
export async function expectAuthenticated(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: '+ New User' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();
}
