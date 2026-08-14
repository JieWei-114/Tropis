import { test, expect, type Page } from '@playwright/test';
import { registerAndLogin, freshUser } from './helpers';

function rowFor(page: Page, email: string) {
  return page.getByRole('row', { name: new RegExp(email) });
}

test.describe('users CRUD', () => {
  test('create, search, edit, delete a user via the UI', async ({ page }) => {
    await registerAndLogin(page);
    const subject = freshUser('crud');

    // ── Create via modal ──────────────────────────────────────────
    await page.getByRole('button', { name: '+ New User' }).click();
    const modal = page.locator('.modal');
    await expect(modal.getByRole('heading', { name: 'New user' })).toBeVisible();
    await modal.getByTestId('user-name').fill(subject.name);
    await modal.getByTestId('user-email').fill(subject.email);
    await modal.getByTestId('user-password').fill(subject.password);
    await modal.getByTestId('user-age').fill(String(subject.age));
    await modal.getByRole('button', { name: 'Create' }).click();
    await expect(modal).toHaveCount(0, { timeout: 20_000 });

    // Appears in the table
    await expect(rowFor(page, subject.email)).toBeVisible({ timeout: 20_000 });

    // ── Search (Elasticsearch; indexing can lag — poll generously) ─
    const search = page.getByPlaceholder(/Search by name or email/);
    await expect(async () => {
      await search.fill('');
      await search.fill(subject.name);
      await expect(rowFor(page, subject.email)).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 60_000, intervals: [3_000] });
    await search.fill('');

    // ── Edit ──────────────────────────────────────────────────────
    const newName = `${subject.name}-edited`;
    await rowFor(page, subject.email).getByRole('button', { name: 'Edit' }).click();
    await expect(modal.getByRole('heading', { name: 'Edit user' })).toBeVisible();
    await modal.getByTestId('user-name').fill(newName);
    await modal.getByRole('button', { name: 'Save (PUT)' }).click();
    await expect(modal).toHaveCount(0, { timeout: 20_000 });
    await expect(rowFor(page, subject.email)).toContainText(newName, { timeout: 20_000 });

    // ── Delete (with inline confirm) ──────────────────────────────
    const row = rowFor(page, subject.email);
    await row.getByRole('button', { name: 'Delete' }).click();
    await row.getByRole('button', { name: 'Confirm' }).click();
    await expect(rowFor(page, subject.email)).toHaveCount(0, { timeout: 20_000 });
  });
});
