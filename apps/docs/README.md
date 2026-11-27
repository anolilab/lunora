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

The site runs as a Cloudflare Worker, deployed by `alchemy.run.ts`, which builds
the site and deploys the Worker with its bindings. Two workflows run it:

- `deploy-docs.yml` deploys stage `prod` on a merge to `alpha`.
- `preview-docs.yml` deploys stage `pr-<number>` for a same-repository pull request
  labelled `preview-docs`, comments the URL, and destroys the stage when the pull
  request closes or loses the label. A preview uses Cloudflare's test Turnstile keys
  and a KV namespace of its own; only `prod` keeps `lunora-docs-waitlist`.

By hand, `pnpm --filter "@lunora/docs" run deploy` deploys `prod`. The script pins
the stage: without it alchemy derives the stage from `$USER`, so every person or CI
runner deploying would create a Worker of its own. State is kept in the Cloudflare
account, so a hand deploy and CI see the same resources. The script reads these from
the environment:

| Variable                                        | What it is                                                                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | The account to deploy to.                                                                                                     |
| `ALCHEMY_PASSWORD`                              | Encrypts secrets in alchemy's state.                                                                                          |
| `ALCHEMY_STATE_TOKEN`                           | Signs access to the state store in the account. Use one value for every deploy to that account.                               |
| `VITE_TURNSTILE_SITE_KEY`                       | Public Turnstile site key, built into the waitlist form. The deploy refuses to run without it.                                |
| `TURNSTILE_SECRET_KEY`                          | Turnstile secret, bound to the Worker; `/api/waitlist` sends it to `siteverify`.                                              |
| `DOCS_CUSTOM_DOMAIN`                            | Optional, `prod` only. Binds this hostname to the Worker, which is the DNS cutover; unset, the Worker answers on workers.dev. |

Create both Turnstile keys in the Cloudflare dashboard (Turnstile, add a widget
for `lunora.sh`). Never commit real keys. The workflows read these as secrets of
the `docs-production` GitHub environment; `docs-preview` holds the account
credentials and state tokens only, and should point at a different Cloudflare
account, because a preview runs the pull request's code with them.

Locally, `pnpm run build` and then `wrangler dev -c dist/server/wrangler.json`
serve the built Worker. Without `VITE_TURNSTILE_SITE_KEY` the form uses
Cloudflare's always-passing
[test site key](https://developers.cloudflare.com/turnstile/troubleshooting/testing/).
Copy `.dev.vars.example` to `.dev.vars` to bind the matching test secret; without
it, sign-ups fail verification. The build copies `.dev.vars` next to the built
Worker, so both `pnpm dev` and `wrangler dev` read it.

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
