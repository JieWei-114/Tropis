import { test, expect } from '@playwright/test';
import { sharedSession } from './helpers';

// The nav is a left sidebar (desktop) plus a compact mobile top bar; both are
// in the DOM, so every link locator takes `.first()` (the sidebar copy).
const NAV = [
  { label: /^Analytics$/, path: '/analytics', heading: 'Analytics Dashboard' },
  { label: /^Users$/, path: '/users' },
  { label: /^Stack$/, path: '/stack' },
];

test.describe('smoke', () => {
  const authenticate = sharedSession();
  test.beforeEach(async ({ page }) => {
    await authenticate(page);
  });

  test('app loads and / redirects to /analytics', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/analytics$/);
    await expect(
      page.getByRole('heading', { name: 'Analytics Dashboard' }),
    ).toBeVisible();
  });

  test('nav links are visible', async ({ page }) => {
    await page.goto('/');
    for (const item of NAV) {
      await expect(
        page.getByRole('link', { name: item.label }).first(),
      ).toBeVisible();
    }
  });

  test('navigating via NavLink clicks works', async ({ page }) => {
    await page.goto('/');
    for (const item of NAV) {
      await page.getByRole('link', { name: item.label }).first().click();
      await expect(page).toHaveURL(new RegExp(`${item.path}$`));
    }
  });

  test('the retired /behavior route redirects to /analytics', async ({
    page,
  }) => {
    await page.goto('/behavior');
    await expect(page).toHaveURL(/\/analytics$/);
    await expect(
      page.getByRole('heading', { name: 'Analytics Dashboard' }),
    ).toBeVisible();
  });

  test('an unknown route falls back to /analytics', async ({ page }) => {
    await page.goto('/no-such-page');
    await expect(page).toHaveURL(/\/analytics$/);
  });

  for (const item of NAV) {
    test(`deep link ${item.path} loads directly and survives reload`, async ({
      page,
    }) => {
      const link = () => page.getByRole('link', { name: item.label }).first();
      await page.goto(item.path);
      await expect(page).toHaveURL(new RegExp(`${item.path}$`));
      // React Router marks the active NavLink with aria-current="page".
      await expect(link()).toHaveAttribute('aria-current', 'page');
      await page.reload();
      await expect(page).toHaveURL(new RegExp(`${item.path}$`));
      await expect(link()).toHaveAttribute('aria-current', 'page');
    });
  }
});

test.describe('smoke (unauthenticated)', () => {
  test('a visitor with no session only sees the login screen', async ({
    page,
  }) => {
    await page.goto('/analytics');
    await expect(page.getByRole('button', { name: 'Register' })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Analytics$/ })).toHaveCount(
      0,
    );
  });
});
