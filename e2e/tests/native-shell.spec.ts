import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * Hardening for the packaged shells (Tauri desktop, Capacitor iOS/Android).
 *
 * A packaged shell can only be driven on a real device, so these tests pin the
 * web-layer behaviour it depends on, at the layer where it CAN be checked:
 *
 *   - the display-cutout insets must not move anything on the web,
 *   - a focused field must be pulled above the soft keyboard,
 *   - viewport height must track the VISIBLE height, not the largest one.
 *
 * The insets and the keyboard are simulated, because a browser reports no
 * cutout and has no keyboard. That exercises the code path; it does not
 * substitute for running the apps.
 */
test.describe('native shell hardening', () => {
  test('display-cutout insets are inert on the web', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/analytics');

    const body = await page.evaluate(() => {
      const cs = getComputedStyle(document.body);
      return {
        padTop: cs.paddingTop,
        padBottom: cs.paddingBottom,
        padLeft: cs.paddingLeft,
        padRight: cs.paddingRight,
      };
    });

    // env(safe-area-inset-*) resolves to 0 in a browser window, so the insets
    // the mobile shells need must cost the web console no stray padding.
    expect(Object.values(body)).toEqual(['0px', '0px', '0px', '0px']);
  });

  test('page height tracks the visible viewport, not the largest one', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/analytics');

    // `100vh` on a phone is the height WITHOUT the browser chrome, so a
    // `min-height: 100vh` shell stays too tall while the URL bar or keyboard
    // is showing and pushes its own footer out of reach. `dvh` tracks what is
    // actually visible.
    const usesDynamicUnit = await page.evaluate(() => {
      const shell = document.querySelector('main')!.parentElement!;
      const declared = getComputedStyle(shell).minHeight;
      return { declared, viewport: window.innerHeight };
    });
    expect(parseInt(usesDynamicUnit.declared, 10)).toBeLessThanOrEqual(
      usesDynamicUnit.viewport,
    );
  });

  test('a focused field is pulled above a soft keyboard', async ({ page }) => {
    // Stub visualViewport BEFORE the app loads so the hook reads the shrunken
    // height, the way it would with a keyboard open.
    const KEYBOARD_PX = 340;
    await page.addInitScript((kb: number) => {
      const shrunken = window.innerHeight - kb;
      Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        value: {
          height: shrunken,
          width: window.innerWidth,
          offsetTop: 0,
          addEventListener() {},
          removeEventListener() {},
        },
      });
    }, KEYBOARD_PX);

    await loginAsAdmin(page);
    await page.setViewportSize({ width: 390, height: 844 });
    // The Fire Events "User ID" box sits far down this page, so it can be
    // parked below the keyboard line; the Users search box cannot (its natural
    // position is already above it).
    await page.goto('/analytics');

    const field = page.getByPlaceholder('user_123');
    await expect(field).toBeVisible();

    const keyboardLine = 844 - KEYBOARD_PX;
    // Scroll so the field's viewport-top lands just below the keyboard line.
    const before = await page.evaluate(
      ({ line }) => {
        const el = document.querySelector<HTMLElement>(
          'input[placeholder="user_123"]',
        )!;
        const target = line + 40;
        window.scrollTo(0, el.offsetTop - target);
        return Math.round(el.getBoundingClientRect().top);
      },
      { line: keyboardLine },
    );
    await page.waitForTimeout(300);

    expect(
      before,
      `field starts at ${before}; it must be below the keyboard line ${keyboardLine} for this to prove anything`,
    ).toBeGreaterThan(keyboardLine);

    await field.focus();
    // The hook waits for the keyboard animation, then smooth-scrolls.
    await page.waitForTimeout(1400);

    const afterTop = await page.evaluate(() =>
      Math.round(
        document
          .querySelector('input[placeholder="user_123"]')!
          .getBoundingClientRect().top,
      ),
    );
    expect(
      afterTop,
      `field moved ${before} -> ${afterTop}; it must end above the keyboard line ${keyboardLine}`,
    ).toBeLessThan(keyboardLine);
  });
});
