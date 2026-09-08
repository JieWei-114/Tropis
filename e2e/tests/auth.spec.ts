import { test, expect } from '@playwright/test';
import {
  freshUser,
  registerAndLogin,
  login,
  expectAuthenticated,
  wsBadge,
} from './helpers';

test.describe('auth', () => {
  test('register a fresh user and land authenticated', async ({ page }) => {
    await registerAndLogin(page);
    // Authenticated shell shows the websocket status badge in the sidebar.
    await expect(wsBadge(page)).toBeVisible();
  });

  test('existing user can sign in', async ({ page }) => {
    const user = await registerAndLogin(page);
    // Log out, then sign back in through login mode.
    await page.getByRole('button', { name: 'Logout' }).click();
    await login(page, user.email, user.password);
    await expectAuthenticated(page);
  });

  test('bad password shows an error', async ({ page }) => {
    const user = await registerAndLogin(page);
    await page.getByRole('button', { name: 'Logout' }).click();
    await login(page, user.email, 'definitely-wrong-password');
    await expect(page.getByTestId('login-error')).toBeVisible({
      timeout: 20_000,
    });
    // Still unauthenticated
    await expect(page.getByRole('button', { name: '+ New User' })).toHaveCount(
      0,
    );
  });

  test('a password shorter than 8 characters is rejected client-side', async ({
    page,
  }) => {
    const user = freshUser('shortpw');
    await page.goto('/users');
    await page.getByRole('button', { name: 'Register' }).click();
    await page.getByTestId('login-name').fill(user.name);
    await page.getByTestId('login-email').fill(user.email);
    await page.getByTestId('login-password').fill('Pass12!'); // 7 chars
    await page
      .getByRole('button', { name: 'Create account & sign in' })
      .click();
    await expect(
      page.getByText('Password must be at least 8 characters'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '+ New User' })).toHaveCount(
      0,
    );
  });

  test('unknown user cannot sign in', async ({ page }) => {
    const nobody = freshUser('ghost');
    await login(page, nobody.email, nobody.password);
    await expect(page.getByTestId('login-error')).toBeVisible({
      timeout: 20_000,
    });
  });
});
