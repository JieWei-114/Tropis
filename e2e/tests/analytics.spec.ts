import { test, expect } from '@playwright/test';
import { loginAsAdmin, uniqueId } from './helpers';

test.describe('analytics', () => {
  // Events travel MongoDB → Pulsar → processor → ClickHouse, then reach the UI
  // over the Socket.io /ws stream (+ the stats endpoints);
  // allow generous, polled timeouts end-to-end.
  test.setTimeout(180_000);

  test('firing an event updates the live feed and stats', async ({ page }) => {
    await loginAsAdmin(page);

    await page.goto('/analytics');
    await expect(
      page.getByRole('heading', { name: 'Analytics Dashboard' }),
    ).toBeVisible();

    // Use a unique user id so we can spot OUR event in the live feed.
    const userId = `e2e_${uniqueId()}`;
    await page.getByPlaceholder('user_123').fill(userId);

    const fire = async () =>
      page.getByRole('button', { name: /Page View/ }).click();
    await fire();
    await expect(page.locator('.fire-status')).toContainText('page_view', {
      timeout: 20_000,
    });

    // Live feed (WebSocket) should eventually show our event; re-fire
    // periodically in case the first one raced the stream subscription.
    const feedItem = page.locator('.feed-item', { hasText: userId });
    await expect(async () => {
      if ((await feedItem.count()) === 0) await fire();
      await expect(feedItem.first()).toBeVisible({ timeout: 10_000 });
    }).toPass({ timeout: 120_000, intervals: [5_000] });

    // Stats should reflect activity: refresh and poll until the 24h total is > 0.
    await expect(async () => {
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      const total = await page
        .locator('.stat-card', { hasText: 'Total Events (24h)' })
        .innerText();
      expect(total).toMatch(/[1-9]/);
    }).toPass({ timeout: 120_000, intervals: [5_000] });
  });
});
