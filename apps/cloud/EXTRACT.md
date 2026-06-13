# Extracting `@cirrus/cloud` into a private repo

The control plane is the proprietary product layer (`CLOUD-PLAN.md` §4) and is
intended to live in its **own private repository**, separate from the
open-source framework. This app is written to make that move mechanical: it
imports **only published `@cirrus/*` package entry points** (verified — no deep
or relative reaches into the monorepo) and keeps all platform logic local to
`apps/cloud`.

## What couples it to the monorepo today (and the swap for standalone)

| Monorepo form                                                           | Standalone-repo form                                                                                                                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"@cirrus/*": "workspace:*"` deps                                       | published versions, e.g. `"@cirrus/server": "^0.1"` (from npm / the private registry)                                                                   |
| `tsconfig.json` `extends: "../../tsconfig.base.json"`                   | inline the few options it needs (`target` ES2024, `module` ESNext, `moduleResolution` bundler, `strict`, `types: ["@cloudflare/workers-types","node"]`) |
| `eslint.config.js` → `@anolilab/eslint-config`                          | already an npm package — keep as-is (just `pnpm add -D @anolilab/eslint-config`)                                                                        |
| `project.json` (vis monorepo metadata)                                  | delete — only the monorepo orchestrator reads it                                                                                                        |
| root `prettier.config.js`                                               | add a local `prettier.config.js` (or `"prettier"` in package.json)                                                                                      |
| catalog refs (`catalog:cloudflare`, `catalog:tsc`, …) in `package.json` | pin concrete versions (the catalog only resolves inside this workspace)                                                                                 |

Everything else is already self-contained.

## Steps

1. `git subtree split --prefix=apps/cloud -b cloud-export` (preserves history),
   or copy the `apps/cloud` tree into a fresh repo.
2. In `package.json`: replace every `workspace:*` with a published version and
   every `catalog:*` with a concrete version; drop `"private": true` only if you
   intend to publish (it stays private as a deployable app).
3. Replace the `extends` in `tsconfig.json` with the inlined compiler options
   above; add a local `prettier.config.js`; remove `project.json`.
4. `pnpm install`, then `pnpm run codegen` (the `@cirrus/cli` dep still drives
   codegen unchanged), then `pnpm run lint:types && pnpm test`.
5. Provision: create the control-plane D1 (`wrangler d1 create cirrus-cloud`),
   fill `wrangler.jsonc`'s `database_id`, copy `.dev.vars.example` → `.dev.vars`.

## Invariants to keep so extraction stays cheap

- **Import only `@cirrus/*` public entry points** (and their documented subpaths
  like `@cirrus/server/data-model`). Never relative-import into `../../packages`.
- Keep all platform logic under `apps/cloud/{cirrus,src}` — no edits to framework
  packages required to run the control plane.
- Treat the framework as a **versioned dependency**: when it ships breaking
  changes, bump the pinned `@cirrus/*` versions deliberately (same as any external
  consumer), rather than tracking `alpha` HEAD.
