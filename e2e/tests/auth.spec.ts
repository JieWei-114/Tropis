import { test, expect } from '@playwright/test';
import { freshUser, registerAndLogin, login, expectAuthenticated } from './helpers';

test.describe('auth', () => {
  test('register a fresh user and land authenticated', async ({ page }) => {
    await registerAndLogin(page);
    // Authenticated shell shows the websocket status badge in the nav.
    await expect(page.locator('.ws-badge')).toBeVisible();
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
    await expect(page.getByTestId('login-error')).toBeVisible({ timeout: 20_000 });
    // Still unauthenticated
    await expect(page.getByRole('button', { name: '+ New User' })).toHaveCount(0);
  });

  test('unknown user cannot sign in', async ({ page }) => {
    const nobody = freshUser('ghost');
    await login(page, nobody.email, nobody.password);
    await expect(page.getByTestId('login-error')).toBeVisible({ timeout: 20_000 });
  });
});
