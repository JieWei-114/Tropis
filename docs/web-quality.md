# Web Quality — SEO, Performance, Accessibility, Best Practices, PWA

How the frontend gets discovered, ranks, and passes an audit — mapped to the
five **Lighthouse** categories.

> **The frontend is split by audience** (see [architecture.md](architecture.md)):
>
> - **harbor** (`frontend/harbor/`) — the **public** site. Next.js App Router,
>   **SSR/SSG**, full SEO. This is where discoverability lives.
> - **helm** (`frontend/helm/`) — the **logged-in admin console**. React + Vite
>   **CSR SPA**, `noindex`. Behind auth, so it carries no SEO value by design;
>   it still owns Performance / a11y / Best Practices / PWA (below).
>
> This split _is_ the answer to "how do we get full SEO without SSR-ing the
> dashboard": SEO-critical pages are server-rendered in harbor; the admin stays
> a simple static SPA. Both reuse `@tropis/sdk` and (eventually) a shared UI package.

## SEO — harbor (public site)

harbor gets SEO the Next-native way — **server-rendered into the HTML**, so
crawlers and non-JS social scrapers see real tags without executing JS:

- **Per-page metadata** via the Next **Metadata API** — a `metadata` export (or
  `generateMetadata()`) per route sets `<title>`, description, canonical, Open
  Graph and Twitter Card tags (`frontend/harbor/app/layout.tsx` holds the
  site-wide defaults + title template).
- **`app/robots.ts`** and **`app/sitemap.ts`** — native, code-generated
  `robots.txt` and `sitemap.xml`; list every public URL in the sitemap.
- Absolute canonical/OG URLs come from `NEXT_PUBLIC_SITE_URL` (per environment).
- **TODO:** add a 1200×630 `og-default.png` for default social previews.

Adding a public page = a folder under `frontend/harbor/app/` with its own
`metadata` export, then add the URL to `app/sitemap.ts`.

## SEO — helm (admin console)

helm is CSR and lives behind auth, so it is deliberately **`noindex`**. Per-page
metadata is still set with the `<Seo>` component
(`frontend/helm/src/features/seo/Seo.tsx`, via `react-helmet-async`) — mainly to
mark routes `noindex` and to give correct titles/social previews when an admin
shares a link:

```tsx
import { Seo } from '../features/seo';

<Seo title="Users" noindex />;
```

It emits `<title>`, description, canonical, OG/Twitter tags; absolute URLs come
from `VITE_SITE_URL`; static fallbacks live in `index.html`, and
`public/robots.txt` disallows the app shell. **Any page that must rank or be
shared publicly belongs in harbor, not helm** (a CSR SPA's tags are invisible to
non-JS crawlers).

## Rendering strategy (CSR / SSR / SSG) — choose per page type

These are **mutually exclusive** ways to render a page, not things to all support
at once. Pick one **per page type**; you do not need "compatibility" with all three.

| Strategy | What                                  | Use for                                                | SEO  | Cost                                   |
| -------- | ------------------------------------- | ------------------------------------------------------ | ---- | -------------------------------------- |
| **CSR**  | Browser runs JS to render             | Logged-in app / dashboard                              | Poor | Lowest                                 |
| **SSG**  | HTML pre-built at build time          | Landing, pricing, blog, docs                           | Good | Low — static files, CDN, no server     |
| **SSR**  | HTML rendered per request on a server | Public pages that are personalised / change constantly | Good | Higher — needs a running Node renderer |

**How this repo applies it (already implemented — this is why the frontend is split):**

- **helm → CSR.** The admin console sits behind auth and carries no SEO value
  (`noindex`). Ships as a tiny static nginx image. Don't SSR it.
- **harbor → SSG/SSR (Next.js).** Public pages are server-rendered so their tags
  are in the raw HTML. Next picks SSG per route automatically (static pages like
  the landing/pricing prerender at build; add SSR/`dynamic` only for pages that
  must be personalised per request).
- Both reuse `@tropis/sdk`; a shared design system can later be extracted to
  `packages/ui`.

Rule of thumb: **needs SEO or must render without JS → harbor. Behind login → helm.**

### Related acronyms (so they don't get conflated)

- **WPO** (Web Performance Optimization) = the **Performance** section below —
  same thing, different name.
- **SEM** (Search Engine _Marketing_) = paid ads (Google Ads). Not a code
  concern; the code only _enables_ it — build good landing pages and let the
  tracking pipeline (`page.view`, conversions) attribute the traffic.
- **ASO** (App Store Optimization) = mobile store ranking (title, keywords,
  screenshots, ratings). Handled at **submission time** for the Capacitor / Tauri
  shells — see [multi-platform.md](multi-platform.md); no app code changes needed.

## Performance (Core Web Vitals)

- **Real-user metrics**: `reportWebVitals()` (`src/lib/webVitals.ts`) measures
  LCP / INP / CLS / FCP / TTFB and sends them through the tracking pipeline as
  the `perf.web_vitals` event (see [tracking-plan.md](tracking-plan.md)) — so
  field data lands in ClickHouse, not just lab Lighthouse runs.
- **Bundle size**: chunking is left to Vite/Rollup's defaults (a hand-rolled
  `manualChunks` that isolated React broke it at runtime). `chunkSizeWarningLimit`
  is raised in `vite.config.ts`; if the entry grows, revisit with a **tested**
  split (verify in a browser, not just a green build).

## Accessibility (a11y)

- Enforced in lint: `eslint-plugin-jsx-a11y` recommended rules are active in
  `eslint.config.js`.
- App shell already ships a skip-to-content link and `aria-live` regions
  (`App.tsx`). Keep new UI keyboard-navigable and labelled.

## Best Practices

- Security headers on the static server (`frontend/helm/nginx.conf`):
  `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
  `Permissions-Policy`, plus a **starter CSP** (commented — `connect-src` is
  per-environment, so tighten it per deploy).
- No mixed content, HTTPS in production (cert-manager/ingress — see
  [deployment.md](deployment.md)).

## PWA

Configured via `vite-plugin-pwa` in `vite.config.ts` (installable manifest,
offline app-shell precache, network-first for `/api/`). Icons in `public/`.

## AEO / GEO (answer & generative engines)

`public/llms.txt` (the [llmstxt.org](https://llmstxt.org) convention) describes
the project so AI/answer engines can discover and cite it. Keep its links and
public-page list current.

## Adding a public page — checklist (harbor)

1. Create `frontend/harbor/app/<route>/page.tsx` (a React Server Component).
2. Export `metadata` (or `generateMetadata()`) with title + description (+
   `alternates.canonical`). Site-wide defaults come from `app/layout.tsx`.
3. Add the URL to `app/sitemap.ts`.
4. It's SSR/SSG by default — tags land in the raw HTML, no extra step.

For an admin (helm) route instead: add it under `frontend/helm/src/pages/`, mark
it `<Seo … noindex />`, and keep it out of the sitemap.
