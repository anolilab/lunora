# Agent Instructions

This file provides guidance to AI coding agents when working with code in this directory.

## Overview

The Lunora documentation & marketing site (`@lunora/docs`) — built with **TanStack Start** (React meta-framework on Vite) with file-based routing via TanStack Router, prerendered to static HTML.

> Deployment target is not yet wired for Lunora (the upstream template targeted Netlify; the `@netlify/vite-plugin-tanstack-start` adapter still runs in production builds). Switching to a Cloudflare Workers target is a tracked follow-up.

## Commands

```bash
pnpm dev               # Dev server (runs generate-packages + copy-docs first)
pnpm build             # generate-packages + copy-docs + check-doc-imports + fetch-stats + vite build
pnpm serve             # Preview production build
pnpm start             # Serve the built output (.output/server/index.mjs)
pnpm lint:doc-imports  # Verify code samples in docs import real, exported symbols
pnpm lint:types        # fumadocs-mdx codegen, then tsc --noEmit
```

## Architecture

### Routing

File-based routing via TanStack Router. Route files live in `src/routes/`. The route tree is auto-generated at `src/routeTree.gen.ts` — do not edit it manually.

### Content & Documentation

Uses **Fumadocs** with MDX. Content sources configured in `source.config.ts`:

- `src/content/docs/` — general guides authored here (getting-started, `concepts/*`, `frameworks/*`, `tutorial/*`, `migrating/*`, operations) **plus** the auto-generated `packages/` subtree.
- `src/content/docs/packages/` — **generated** (gitignored). Collected from each package's `docs/` folder — do not edit by hand.
- `src/content/docs-static/` — static source pages (e.g. the packages index).
- `src/content/changelogs/` — changelog entries.

**Docs live next to the code.** Each package keeps a `docs/` folder
(`packages/<name>/docs/index.mdx`, plus optional extra pages + a `meta.json`
for ordering). `copy-package-docs.js` collects them. Lunora's packages are
**flat** (`packages/<name>/`, scope `@lunora/*`, unscoped umbrella `lunora`) —
there are no category sub-folders.

### Build-time Data Generation

Scripts run before Vite build (in order):

1. **`scripts/generate-packages.js`** — discovers flat workspace packages via `project.json` `category:*` tags + `package.json`, merges with `src/data/packages-metadata.json`, outputs `src/data/packages.ts`.
2. **`scripts/copy-package-docs.js`** — copies every `packages/<name>/docs/` into `src/content/docs/packages/<name>/`, sanitises MDX for Fumadocs, and builds a categorised `packages/meta.json` (categories come from `CATEGORY_CONFIG`).
3. **`scripts/check-doc-imports.mjs`** — fails the build when a code sample imports a symbol no package actually exports. Run it alone with `pnpm lint:doc-imports`; it does not run in `dev`.
4. **`scripts/fetch-stats.js`** — fetches npm + GitHub stats (derived from `packages.ts`, repo `anolilab/lunora`) into `src/data/stats.json`. Network-bound; skipped by `dev`.

### Adding a Package to the Website

1. Create `packages/<name>/docs/index.mdx` (add more pages + `meta.json` as needed).
2. Add a `category:<slug>` tag to the package's `project.json` (valid slugs: `runtime`, `client`, `vite-plugin`, `codegen`, `cli`, `dev-tools`, `advisor`, `add-on`). Add the slug to `CATEGORY_CONFIG` in `copy-package-docs.js` if it's new.
3. Optionally add `displayName` / `description` / `features` to `src/data/packages-metadata.json`.
4. The package appears in the showcase and docs on the next build.

### Styling

- **Tailwind CSS v4** with `@tailwindcss/vite` plugin
- Tailwind v4 `@theme`/`@variant` syntax in `src/app.css`
- **shadcn/ui** components (New York style) — config in `components.json`
- Components use **CVA** (class-variance-authority) for variant styling
- Geist Sans/Mono fonts loaded via `unplugin-fonts`

### Component Organization

- `src/components/ui/` — shadcn/ui primitives
- `src/components/sections/` — page layout sections (navbar, footer, hero)
- `src/components/seo/` — meta tags and structured data
- `src/pages/` — page-level components used by routes

### Dev-only Tools

`vite.config.ts` _optionally_ loads these in development via a `tryRequire`
guard — they are **not** declared dependencies of this app, so they simply
no-op unless present in the workspace:

- `@visulima/dev-toolbar` — a11y auditing, performance monitoring, inspector
- `@visulima/vite-overlay` — enhanced error overlay

### Special Build Features

- Image optimization via `vite-imagetools`
- SVG → React components via `vite-plugin-svgr`
- Babel React Compiler plugin for production optimization
- `llms.txt` / `llms-full.txt` generation for LLM context
- OG image generation at `/api/og`
