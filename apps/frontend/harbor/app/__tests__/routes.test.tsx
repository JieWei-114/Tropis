import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import type { Metadata } from 'next';
import { describe, expect, it } from 'vitest';
import { metadata as rootMetadata } from '../layout';
import HomePage, { metadata as homeMetadata } from '../page';
import PricingPage, { metadata as pricingMetadata } from '../pricing/page';

// vitest runs with the app root as cwd.
const APP_DIR = resolve(process.cwd(), 'app');

/** Route folders that Next turns into public pages (page.tsx present). */
function routeSegments(): string[] {
  return readdirSync(APP_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .filter((entry) => existsSync(join(APP_DIR, entry.name, 'page.tsx')))
    .map((entry) => entry.name);
}

/** Metadata `title` is a string on pages and an object on the root layout. */
function titleText(title: Metadata['title']): string {
  if (typeof title === 'string') return title;
  if (title && typeof title === 'object' && 'default' in title) {
    return String(title.default);
  }
  return '';
}

const PAGES = [
  { name: '/', Page: HomePage, metadata: homeMetadata, path: '/' },
  {
    name: '/pricing',
    Page: PricingPage,
    metadata: pricingMetadata,
    path: '/pricing',
  },
];

describe('routes', () => {
  it('has a test for every page route under app/', () => {
    // Guards against a new page being added without a render test.
    const covered = PAGES.map((p) => p.path.replace(/^\//, '')).filter(Boolean);
    expect(routeSegments().sort()).toEqual(covered.sort());
  });

  it.each(PAGES)(
    '$name renders a heading and real body content',
    ({ Page }) => {
      const { container, unmount } = render(<Page />);

      const heading = screen.getByRole('heading', { level: 1 });
      expect(heading).toBeInTheDocument();
      expect(heading.textContent?.trim().length ?? 0).toBeGreaterThan(0);

      // "Real content", not an empty shell.
      expect(container.textContent?.trim().length ?? 0).toBeGreaterThan(120);
      expect(container.querySelectorAll('a').length).toBeGreaterThan(0);

      unmount();
    },
  );

  it('/ renders the console link and every listed feature and stack pill', () => {
    render(<HomePage />);

    const console = screen.getByRole('link', { name: /open the console/i });
    expect(console).toHaveAttribute(
      'href',
      expect.stringMatching(/^https?:\/\//),
    );

    for (const title of [
      'Live by default',
      'Real analytics',
      'A real pipeline',
      'Self-hosted & yours',
    ]) {
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    }

    for (const label of [
      'Core data path',
      'Feature',
      'Ops / delivery',
      'Demo / reference',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText('ClickHouse')).toBeInTheDocument();
  });

  it('/pricing links back home', () => {
    render(<PricingPage />);
    expect(screen.getByRole('link', { name: /back home/i })).toHaveAttribute(
      'href',
      '/',
    );
  });
});

describe('page metadata', () => {
  it.each(PAGES)(
    '$name has a non-empty title and description',
    ({ metadata }) => {
      expect(titleText(metadata.title).trim().length).toBeGreaterThan(0);
      expect(String(metadata.description ?? '').trim().length).toBeGreaterThan(
        20,
      );
    },
  );

  it.each(PAGES)(
    '$name declares an absolute canonical for itself',
    ({ metadata, path }) => {
      const canonical = String(metadata.alternates?.canonical ?? '');
      expect(() => new URL(canonical)).not.toThrow();
      expect(new URL(canonical).pathname).toBe(path);
    },
  );

  it('the root layout supplies defaults, a metadataBase and OG/Twitter cards', () => {
    expect(titleText(rootMetadata.title).trim().length).toBeGreaterThan(0);
    expect(
      String(rootMetadata.description ?? '').trim().length,
    ).toBeGreaterThan(20);
    expect(String(rootMetadata.metadataBase)).toMatch(/^https?:\/\//);

    const template = (rootMetadata.title as { template?: string } | undefined)
      ?.template;
    expect(template).toContain('%s');

    expect(rootMetadata.openGraph?.title).toBeTruthy();
    expect(rootMetadata.openGraph?.description).toBeTruthy();
    expect(rootMetadata.openGraph?.images).toEqual(['/og-default.png']);
    // Metadata['twitter'] is a union of card shapes; narrow to read `card`.
    const twitter = rootMetadata.twitter as {
      card?: string;
      images?: unknown;
    } | null;
    expect(twitter?.card).toBe('summary_large_image');
    expect(twitter?.images).toEqual(['/og-default.png']);
  });

  it('gives every page a distinct title', () => {
    const titles = PAGES.map((p) => titleText(p.metadata.title));
    expect(new Set(titles).size).toBe(titles.length);
  });
});
