import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Guards the palette's readability.
 *
 * Contrast is a property of the token VALUES, so it is invisible to component
 * tests and to the eye of whoever picks a colour: only reading the tokens and
 * doing the arithmetic can prove the palette is readable.
 *
 * Text tokens are checked against every ground they can land on — background,
 * card, surface and raised — because a tier that only passes on the page
 * background is unreadable inside a card or a chip. Both themes are checked.
 */

const CSS = readFileSync(join(__dirname, '..', 'index.css'), 'utf8');

/** Tokens that paint TEXT. `--primary` is deliberately absent: at 3.62:1 on
 *  cream it is a fill/border colour, and `--primary-soft` is its text form. */
const TEXT_TOKENS = [
  'foreground',
  'heading',
  'body',
  'soft',
  'muted',
  'faint',
  'primary-soft',
  'success',
  'warning',
  'danger',
] as const;

/** Every surface a text token can sit on. */
const GROUNDS = ['background', 'card', 'surface', 'raised'] as const;

/** WCAG 2.1 AA for normal-size text. */
const AA_NORMAL = 4.5;

/**
 * Reads a theme's token block. Light lives on bare `:root`, dark on `.dark` —
 * the `@media`/`[data-theme]` duplicates carry the same values.
 */
function readTheme(selector: ':root' | '.dark'): Record<string, string> {
  const start = CSS.indexOf(`${selector} {`);
  expect(start, `${selector} block present`).toBeGreaterThan(-1);
  const block = CSS.slice(start, CSS.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(
    /--([a-z-]+):\s*(#[0-9a-fA-F]{6})/g,
  )) {
    out[name] = value;
  }
  return out;
}

function relativeLuminance(hex: string): number {
  const n = hex.replace('#', '');
  const channels = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (x, y) => y - x,
  );
  return (hi + 0.05) / (lo + 0.05);
}

describe.each([
  ['light', ':root'],
  ['dark', '.dark'],
] as const)('%s palette', (_theme, selector) => {
  const tokens = readTheme(selector);

  it('defines every text token and every ground', () => {
    for (const name of [...TEXT_TOKENS, ...GROUNDS]) {
      expect(tokens[name], `--${name}`).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it.each(TEXT_TOKENS)('--%s clears AA on every ground', (token) => {
    for (const ground of GROUNDS) {
      const ratio = contrast(tokens[token], tokens[ground]);
      expect(
        ratio,
        `--${token} on --${ground} is ${ratio.toFixed(2)}:1, needs ${AA_NORMAL}`,
      ).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });

  it('keeps the de-emphasis ramp ordered and visibly stepped', () => {
    const bg = tokens.background;
    const ramp = ['heading', 'body', 'soft', 'muted', 'faint'] as const;
    const ratios = ramp.map((t) => contrast(tokens[t], bg));

    for (let i = 1; i < ratios.length; i++) {
      // Strictly decreasing: a tier that is not lighter than the one above it
      // conveys no hierarchy.
      expect(
        ratios[i],
        `--${ramp[i]} must be less prominent than --${ramp[i - 1]}`,
      ).toBeLessThan(ratios[i - 1]);
    }
  });
});
