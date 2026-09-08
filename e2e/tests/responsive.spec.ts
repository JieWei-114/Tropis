import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * Phone and tablet layout.
 *
 * The console shell puts the desktop sidebar, the mobile top bar and <main> in
 * one flex container, so its direction decides whether <main> gets any width at
 * all — a layout property that only a narrow viewport can reveal. Every other
 * suite runs at 1280px; this one sweeps the widths users actually hold and
 * pins the floor: no horizontal overflow, a main region that occupies the
 * screen, real content, and every destination plus sign-out reachable without
 * a swipe.
 */

const VIEWPORTS = [
  { name: 'phone-small', width: 375, height: 667 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'laptop', width: 1024, height: 768 },
];

const PAGES = ['/analytics', '/users', '/stack'];

test.describe('responsive shell', () => {
  test.setTimeout(120_000);

  test('every page fits and stays usable at every width', async ({ page }) => {
    await loginAsAdmin(page);

    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });

      for (const path of PAGES) {
        await page.goto(path);
        const label = `${vp.name} ${path}`;

        await expect
          .poll(
            () =>
              page
                .locator('body')
                .innerText()
                .then((t) => t.length),
            { message: `${label} rendered content`, timeout: 20_000 },
          )
          .toBeGreaterThan(200);

        const metrics = await page.evaluate(() => {
          const vw = document.documentElement.clientWidth;
          const main = document.querySelector('main')!.getBoundingClientRect();
          // A destination only counts if it is inside the viewport: the mobile
          // nav is a horizontal scroller, and a tab parked off-screen is not
          // discoverable.
          const visibleNav = Array.from(
            document.querySelectorAll(
              'a[href="/analytics"],a[href="/users"],a[href="/stack"]',
            ),
          ).filter((a) => {
            const r = a.getBoundingClientRect();
            return r.width > 0 && r.left >= -1 && r.right <= vw + 1;
          }).length;
          return {
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            mainWidth: Math.round(main.width),
            viewportWidth: vw,
            visibleNav,
          };
        });

        // Wide content (tables, charts) must scroll inside its own container.
        expect(
          metrics.overflow,
          `${label} horizontal overflow`,
        ).toBeLessThanOrEqual(2);
        expect(metrics.mainWidth, `${label} main width`).toBeGreaterThan(
          metrics.viewportWidth * 0.5,
        );
        expect(metrics.visibleNav, `${label} visible nav links`).toBe(3);
      }
    }
  });

  test('sign-out and the display controls are reachable on a phone', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/analytics');

    // These live in the desktop sidebar, so the mobile header must carry its
    // own copies or a phone user cannot sign out or switch language at all.
    await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();
    await expect(page.getByRole('button', { name: /theme/i })).toBeVisible();
  });
});
