# Lunora — Documentation & Website

The official documentation and marketing site for **Lunora**, built with Vite, React 19, TypeScript, Tailwind CSS, and TanStack Start.

## Tech Stack

- **TanStack Start** (React meta-framework on Vite) with file-based routing
- **Fumadocs** for MDX-powered documentation
- **Tailwind CSS v4** + shadcn/ui components
- Geist Sans / Geist Mono fonts via `unplugin-fonts`

## Development

```bash
pnpm --filter "@lunora/docs" run dev      # dev server (runs generate-packages + copy-docs first)
pnpm --filter "@lunora/docs" run build     # production build (generate-packages + copy-docs + fetch-stats + vite build)
pnpm --filter "@lunora/docs" run serve     # preview the production build
```

## How the docs are sourced

Documentation lives **next to the code it documents**. Each package keeps a
`docs/` folder (e.g. `packages/server/docs/index.mdx`), and the build collects
them into the site:

1. **`scripts/generate-packages.js`** — discovers workspace packages via their
   `project.json` `category:*` tags + `package.json`, merged with curated
   `src/data/packages-metadata.json`, and writes `src/data/packages.ts`.
2. **`scripts/copy-package-docs.js`** — copies every `packages/<name>/docs/`
   folder into `src/content/docs/packages/<name>/`, sanitises the MDX for
   Fumadocs, and generates a categorised `packages/meta.json` sidebar.
3. **`scripts/fetch-stats.js`** — pre-fetches npm + GitHub stats into
   `src/data/stats.json` (network; only needed for production builds).

General guides (getting-started, concepts, frameworks, tutorial, operations)
live directly in `src/content/docs/`.

### Adding docs for a package

1. Create `packages/<name>/docs/index.mdx` (add more pages + a `meta.json` for
   ordering as needed).
2. Ensure the package's `project.json` has a `category:<slug>` tag.
3. Run `pnpm --filter "@lunora/docs" run copy-docs` (or just `dev`/`build`).

## Credits

Developed and designed by [Anolilab](https://anolilab.com).
