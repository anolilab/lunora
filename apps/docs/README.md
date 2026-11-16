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

## Deploying

The site runs as a Cloudflare Worker. `pnpm --filter "@lunora/docs" run deploy`
runs `alchemy.run.ts`, which builds the site and deploys the Worker with its
bindings. It reads these from the environment:

| Variable                                        | What it is                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | The account to deploy to.                                                                      |
| `ALCHEMY_PASSWORD`                              | Encrypts secrets in alchemy's state.                                                           |
| `VITE_TURNSTILE_SITE_KEY`                       | Public Turnstile site key, built into the waitlist form. The deploy refuses to run without it. |
| `TURNSTILE_SECRET_KEY`                          | Turnstile secret, bound to the Worker; `/api/waitlist` sends it to `siteverify`.               |

Create both Turnstile keys in the Cloudflare dashboard (Turnstile, add a widget
for `lunora.sh`). Never commit real keys.

Locally, `pnpm run build` and then `wrangler dev -c dist/server/wrangler.json`
serve the built Worker. Without `VITE_TURNSTILE_SITE_KEY` the form uses
Cloudflare's always-passing
[test site key](https://developers.cloudflare.com/turnstile/troubleshooting/testing/),
and `wrangler.jsonc` binds the matching test secret, so sign-ups work locally
with no setup.

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
