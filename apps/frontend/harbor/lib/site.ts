/**
 * Site-wide constants for the public site (harbor).
 * SITE_URL builds absolute canonical/OG URLs — set NEXT_PUBLIC_SITE_URL per env.
 * An empty value counts as unset: an unset CI repository variable reaches the
 * build as an empty string.
 */
export const SITE_NAME = 'Tropis';
export const SITE_DESCRIPTION =
  'Tropis — the keel. The foundation every product is built on.';
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') ||
  'http://localhost:4000';
/** Where the "Open the console" link points — helm (the console), per environment. */
export const CONSOLE_URL =
  process.env.NEXT_PUBLIC_CONSOLE_URL?.replace(/\/$/, '') ||
  'http://localhost:8088';
