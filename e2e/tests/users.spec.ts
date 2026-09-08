import { test, expect, type Page } from '@playwright/test';
import { loginAsAdmin, freshUser } from './helpers';

function rowFor(page: Page, email: string) {
  return page.getByRole('row', { name: new RegExp(email) });
}

test.describe('users CRUD', () => {
  test('create, search, edit, delete a user via the UI', async ({ page }) => {
    await loginAsAdmin(page);
    const subject = freshUser('crud');

    // ── Create via modal ──────────────────────────────────────────
    await page.getByRole('button', { name: '+ New User' }).click();
    const modal = page.locator('.modal');
    await expect(
      modal.getByRole('heading', { name: 'New user' }),
    ).toBeVisible();
    await modal.getByTestId('user-name').fill(subject.name);
    await modal.getByTestId('user-email').fill(subject.email);
    await modal.getByTestId('user-password').fill(subject.password);
    await modal.getByTestId('user-age').fill(String(subject.age));
    await modal.getByRole('button', { name: 'Create' }).click();
    await expect(modal).toHaveCount(0, { timeout: 20_000 });

    // ── Find it via search ────────────────────────────────────────
    // The unfiltered table only renders page 1 (limit 20, unsorted) and the
    // page has no pager, so a brand-new user is NOT reliably in that list.
    // Search is the only view guaranteed to contain it. Elasticsearch
    // indexing can lag, so poll generously.
    const search = page.getByPlaceholder(/Search by name or email/);
    await expect(async () => {
      await search.fill('');
      await search.fill(subject.name);
      await expect(rowFor(page, subject.email)).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 60_000, intervals: [3_000] });

    // ── Edit (staying inside the filtered view) ───────────────────
    const newName = `${subject.name}-edited`;
    await rowFor(page, subject.email)
      .getByRole('button', { name: 'Edit' })
      .click();
    await expect(
      modal.getByRole('heading', { name: 'Edit user' }),
    ).toBeVisible();
    await modal.getByTestId('user-name').fill(newName);
    // PUT is a full replacement, so re-send every field. Age must be re-filled
    // explicitly: the form rejects the 0 the server returns for an unset age.
    await modal.getByTestId('user-age').fill(String(subject.age));
    await modal.getByRole('button', { name: 'Save (PUT)' }).click();
    await expect(modal).toHaveCount(0, { timeout: 20_000 });
    // The filtered view is served by Elasticsearch, which reindexes
    // asynchronously — re-run the query until the rename shows up.
    await expect(async () => {
      await search.fill('');
      await search.fill(subject.name);
      await expect(rowFor(page, subject.email)).toContainText(newName, {
        timeout: 5_000,
      });
    }).toPass({ timeout: 60_000, intervals: [3_000] });

    // ── Delete (with inline confirm) ──────────────────────────────
    const row = rowFor(page, subject.email);
    await row.getByRole('button', { name: 'Delete' }).click();
    await row.getByRole('button', { name: 'Confirm' }).click();
    // Same reindex lag on the way out — poll until the row is gone.
    await expect(async () => {
      await search.fill('');
      await search.fill(subject.name);
      await expect(rowFor(page, subject.email)).toHaveCount(0, {
        timeout: 5_000,
      });
    }).toPass({ timeout: 60_000, intervals: [3_000] });
  });
});
