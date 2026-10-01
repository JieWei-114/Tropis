# Web Quality — SEO, Performance, Accessibility, Best Practices, PWA

How the frontend gets discovered, ranks, and passes an audit — organised by the
**Lighthouse** audit categories plus PWA.

> **The frontend is split by audience** (see [architecture.md](architecture.md)):
>
> - **harbor** (`apps/frontend/harbor/`) — the **public** site. Next.js App Router,
>   **SSR/SSG**, full SEO. This is where discoverability lives.
> - **helm (the console)** (`apps/frontend/helm/`) — the **logged-in console**. React + Vite
>   **CSR SPA**, kept out of search indexes. Behind auth, so it carries no SEO value by design;
>   it still owns Performance / a11y / Best Practices / PWA (below).
>
> This split is how the project gets full SEO without server-rendering the
> dashboard: SEO-critical pages are server-rendered in harbor; the admin stays
> a static SPA. helm talks to the backend through `@tropis/sdk`; harbor has no
> API dependency.

## SEO — harbor (public site)

harbor gets SEO the Next-native way — **server-rendered into the HTML**, so
crawlers and non-JS social scrapers see real tags without executing JS:

- **Per-page metadata** via the Next **Metadata API** — a `metadata` export (or
  `generateMetadata()`) per route sets `<title>`, description, canonical, Open
  Graph and Twitter Card tags. `apps/frontend/harbor/app/layout.tsx` holds the
  site-wide defaults, `metadataBase` and the `%s · Tropis` title template;
  `app/page.tsx` and `app/pricing/page.tsx` each export their own `metadata`
  with `alternates.canonical`.
- **`app/robots.ts`** and **`app/sitemap.ts`** — native, code-generated
  `robots.txt` (allow all, points at the sitemap) and `sitemap.xml`. List every
  public URL in the sitemap.
- Absolute canonical/OG URLs come from `NEXT_PUBLIC_SITE_URL` (per environment,
  read in `apps/frontend/harbor/lib/site.ts`; defaults to `http://localhost:4000`).
- Default social-preview image `og-default.png` (1200×630) lives in `apps/frontend/harbor/public/`.

Adding a public page = a folder under `apps/frontend/harbor/app/` with its own
`metadata` export, then add the URL to `app/sitemap.ts`.

## SEO — helm (the console)

helm is CSR and lives behind auth, so it must not be indexed. Per-page
metadata is set with the `<Seo>` component
(`apps/frontend/helm/src/features/seo/Seo.tsx`, via `react-helmet-async`) — mainly to
mark routes `noindex` and to give correct titles/social previews when an admin
shares a link. Only `AnalyticsPage` renders `<Seo … noindex />`; `UsersPage` and
`StackPage` render no `<Seo>`, and `index.html` has no robots meta, so those
routes rely on `public/robots.txt` alone. Rule: every new helm page renders
`<Seo … noindex />`, so a page stays out of the index even where robots.txt is
not honoured:

```tsx
import { Seo } from '../features/seo';

<Seo title="Users" noindex />;
```

It emits `<title>`, description, canonical, OG/Twitter tags, and
`robots: noindex, nofollow` when `noindex` is set; absolute URLs come from
`VITE_SITE_URL`; static fallbacks live in `index.html`, and `public/robots.txt`
disallows the whole app (`Disallow: /`). **Any page that must rank or be shared
publicly belongs in harbor, not helm** (a CSR SPA's tags are invisible to
non-JS crawlers).

## Rendering strategy (CSR / SSR / SSG) — choose per page type

These are **mutually exclusive** ways to render a page, not things to all support
at once. Pick one **per page type**.

| Strategy | What                                  | Use for                                                | SEO  | Cost                                   |
| -------- | ------------------------------------- | ------------------------------------------------------ | ---- | -------------------------------------- |
| **CSR**  | Browser runs JS to render             | Logged-in app / dashboard                              | Poor | Lowest                                 |
| **SSG**  | HTML pre-built at build time          | Landing, pricing, blog, docs                           | Good | Low — static files, CDN, no server     |
| **SSR**  | HTML rendered per request on a server | Public pages that are personalised / change constantly | Good | Higher — needs a running Node renderer |

**How this repo applies it:**

- **helm → CSR.** The console sits behind auth and carries no SEO value
  (not indexed). Ships as a static nginx image. Don't SSR it.
- **harbor → SSG/SSR (Next.js).** Public pages are server-rendered so their tags
  are in the raw HTML. Next picks SSG per route automatically (static pages like
  the landing and pricing pages prerender at build; use SSR/`dynamic` only for
  pages that must be personalised per request). It ships as a Next.js
  `standalone` Node server (`next.config.mjs`).

Rule of thumb: **needs SEO or must render without JS → harbor. Behind login → helm.**

### Related acronyms (so they don't get conflated)

- **WPO** (Web Performance Optimization) = the **Performance** section below —
  same thing, different name.
- **SEM** (Search Engine _Marketing_) = paid ads (Google Ads). Not a code
  concern; the code only _enables_ it — build good landing pages and attribute
  the traffic with analytics.
- **ASO** (App Store Optimization) = mobile store ranking (title, keywords,
  screenshots, ratings). Handled at **submission time** for the Capacitor / Tauri
  shells — see [deployment.md](deployment.md); no app code changes needed.

## Performance (Core Web Vitals)

- **Real-user metrics** (helm): `reportWebVitals()`
  (`apps/frontend/helm/src/lib/webVitals.ts`, called from `src/main.tsx`) measures
  LCP / INP / CLS / FCP / TTFB and sends them through the tracking pipeline as
  the `perf.web_vitals` event (see [tracking-plan.md](tracking-plan.md)) — so
  field data lands in ClickHouse, not just lab Lighthouse runs.
- **Bundle size** (helm): chunking is left to Vite/Rollup's defaults — a
  hand-rolled `manualChunks` that isolates React breaks React's load order at
  runtime. `chunkSizeWarningLimit` is set to 900 kB in `vite.config.ts`; any
  custom split must be verified in a browser, not just a green build.

## Accessibility (a11y)

- Enforced in lint: `eslint-plugin-jsx-a11y` recommended rules are active in
  `apps/frontend/helm/eslint.config.js`.
- The helm app shell (`src/app/App.tsx`) ships a skip-to-content link. The only
  `aria-live` attribute is on the Suspense loading fallback (`PageFallback`,
  `role="status"` in `App.tsx`); form errors (`LoginForm`, `UserModal`) and
  toasts (`components/Toasts.tsx`) are announced through `role="alert"`. Keep new UI keyboard-navigable and labelled.

## Best Practices

- Security headers on helm's static server (`apps/frontend/helm/nginx.conf`):
  `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`,
  `Permissions-Policy` and a strict `Content-Security-Policy`: scripts only
  from the origin plus the theme bootstrap's `sha256-` hash, `connect-src`
  rendered per build from the `VITE_*` endpoints by
  `scripts/render-nginx-conf.mjs`, which fails the image build when the inline
  script's hash is stale ([deployment.md](deployment.md#frontends-endpoints-are-baked-in-at-build-time)).
- harbor's `next.config.mjs` sends the same headers plus
  `Strict-Transport-Security` and a CSP whose `script-src` allows
  `'unsafe-inline'`, because Next.js inlines its bootstrap scripts and a nonce
  would make every page dynamic.
- No mixed content, HTTPS in production (cert-manager/ingress — see
  [deployment.md](deployment.md)).

## Lighthouse CI

The `ci.yml` `lighthouse` job builds helm and runs `@lhci/cli` against the static
`dist/` using `apps/frontend/helm/.lighthouserc.json`. It asserts Performance
(≥ 0.8), Accessibility, Best Practices and SEO (≥ 0.9 each) at `warn` level, so
low scores show in the run but do not fail CI; switch an assertion to `error`
to enforce it. The SEO assertion cannot pass on helm: its `robots.txt` disallows
all crawling, which fails Lighthouse's crawlability audit, so switch the other
categories to `error`, not SEO. harbor is not audited by this job.

## PWA

helm is configured via `vite-plugin-pwa` in `vite.config.ts`: installable
manifest (`display: standalone`), auto-updating service worker, offline
app-shell precache, network-first caching for `/api/` (5 s timeout), and a
navigation fallback that never handles `/api/`. Icons (`pwa-192x192.png`,
`pwa-512x512.png`, `apple-touch-icon.png`) live in `apps/frontend/helm/public/`.

## AEO / GEO (answer & generative engines)

`apps/frontend/helm/public/llms.txt` (the llmstxt.org
convention) describes the project for AI/answer engines. As deployed it is not
reachable by crawlers: helm serves it, helm's `robots.txt` disallows all
crawling, and its `/docs/*.md` links do not exist on that origin. To be
discoverable it must be served from harbor with links that resolve there.

## Adding a public page — checklist (harbor)

1. Create `apps/frontend/harbor/app/<route>/page.tsx` (a React Server Component).
2. Export `metadata` (or `generateMetadata()`) with title + description (+
   `alternates.canonical`). Site-wide defaults come from `app/layout.tsx`.
3. Add the URL to `app/sitemap.ts`.
4. It's SSR/SSG by default — tags land in the raw HTML, no extra step.

For an admin (helm) route instead: add the page under `apps/frontend/helm/src/pages/`,
register its `<Route>` in `src/app/App.tsx`, mark it `<Seo … noindex />`, and keep it
out of any sitemap.
