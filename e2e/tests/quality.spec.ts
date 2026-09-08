import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

const PAGES = ['/analytics', '/users', '/stack'];

/**
 * Cross-cutting checks that no per-feature spec owns.
 *
 * A functional spec passes as long as it finds its own elements, so it stays
 * green while the console fills with unhandled rejections, a theme renders
 * unstyled, or a page ships hardcoded English. These assert the properties
 * that must hold on every page, whatever that page's own spec checks.
 */
test.describe('quality', () => {
  test.setTimeout(120_000);

  test('every page renders in both themes with no console errors', async ({
    page,
  }) => {
    const problems: string[] = [];
    page.on('console', (m) => {
      // An in-flight fetch/WebSocket torn down by navigation surfaces as an
      // InvalidStateError in Firefox; it is the same abort as above.
      if (m.type() !== 'error') return;
      if (/InvalidStateError|NS_BINDING_ABORTED/i.test(m.text())) return;
      problems.push(`console.error: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    // A request cancelled because the test navigated away is normal, and each
    // engine words it differently (Firefox NS_BINDING_ABORTED, Chromium
    // net::ERR_ABORTED, WebKit "cancelled"). Only real transport failures
    // count.
    const ABORTED = /aborted|cancell?ed|NS_BINDING_ABORTED/i;
    page.on('requestfailed', (r) => {
      const why = r.failure()?.errorText ?? '';
      if (r.url().includes('favicon') || ABORTED.test(why)) return;
      problems.push(`requestfailed ${r.url()}: ${why}`);
    });

    await loginAsAdmin(page);

    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => {
        document.documentElement.classList.toggle('dark', t === 'dark');
        localStorage.setItem('theme', t);
      }, theme);

      for (const path of PAGES) {
        await page.goto(path);
        // Each page fetches before it has anything to show, and the dashboard
        // polls continuously — so poll for content rather than waiting for the
        // network to go idle, which never happens here.
        await expect
          .poll(
            () =>
              page
                .locator('body')
                .innerText()
                .then((t) => t.length),
            {
              message: `${theme} ${path} rendered content`,
              timeout: 20_000,
            },
          )
          .toBeGreaterThan(200);
        // The body must carry an explicit token background in both themes; a
        // transparent body means the palette failed to load.
        const bg = await page.evaluate(
          () => getComputedStyle(document.body).backgroundColor,
        );
        expect(bg, `${theme} ${path} body background`).not.toBe(
          'rgba(0, 0, 0, 0)',
        );
      }
    }

    expect(problems, problems.join('\n')).toHaveLength(0);
  });

  test('the Stack page is translated, not hardcoded English', async ({
    page,
  }) => {
    await loginAsAdmin(page);

    await page.goto('/stack');
    await expect(page.getByText('Application services')).toBeVisible();

    await page.evaluate(() => localStorage.setItem('i18nextLng', 'zh'));
    await page.reload();
    // The category headings come from the locale files; if the component ever
    // regresses to literals, the English text survives the language switch.
    await expect(page.getByText('Application services')).toHaveCount(0);
  });
});
