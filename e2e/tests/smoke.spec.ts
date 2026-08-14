import { test, expect } from '@playwright/test';

const TABS = [
  { label: /Analytics/, path: '/analytics', marker: /Analytics Dashboard/ },
  { label: /Users/, path: '/users', marker: /Sign in|Users/ },
  { label: /Stack/, path: '/stack' },
  { label: /State/, path: '/state-demo' },
];

test.describe('smoke', () => {
  test('app loads and / redirects to /analytics', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/analytics$/);
    await expect(page.getByRole('heading', { name: 'Analytics Dashboard' })).toBeVisible();
  });

  test('nav tabs are visible', async ({ page }) => {
    await page.goto('/');
    for (const tab of TABS) {
      await expect(page.getByRole('link', { name: tab.label })).toBeVisible();
    }
  });

  test('navigating via NavLink clicks works', async ({ page }) => {
    await page.goto('/');
    for (const tab of TABS) {
      await page.getByRole('link', { name: tab.label }).click();
      await expect(page).toHaveURL(new RegExp(`${tab.path}$`));
    }
  });

  for (const tab of TABS) {
    test(`deep link ${tab.path} loads directly and survives reload`, async ({ page }) => {
      await page.goto(tab.path);
      await expect(page).toHaveURL(new RegExp(`${tab.path}$`));
      // the active tab is highlighted
      await expect(page.getByRole('link', { name: tab.label })).toHaveClass(/app-tab--active/);
      await page.reload();
      await expect(page).toHaveURL(new RegExp(`${tab.path}$`));
      await expect(page.getByRole('link', { name: tab.label })).toHaveClass(/app-tab--active/);
    });
  }
});
