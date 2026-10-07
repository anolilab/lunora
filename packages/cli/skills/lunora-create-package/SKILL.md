---
name: lunora-create-package
description: Builds a reusable Lunora capability, either as a registry item that
    `lunora add` / `lunora registry add` copies into an app's `lunora/`, or as a
    publishable `@lunora/*` workspace package in the Lunora monorepo. Use when the
    user wants to package schema + functions + wrangler bindings + env vars for
    other apps, add or edit an item under `registry/<name>/` (`registry.json`),
    run `vis generate lunora-package`, or wire a new `ctx.*` capability into
    codegen.
---

# Lunora Create Package

Pick the shape by whether the code is copied into the user's `lunora/` or
imported as a dependency:

| Shape         | Distribution                     | Use for                                          |
| ------------- | -------------------------------- | ------------------------------------------------ |
| Registry item | `lunora registry add <name>`     | App-owned code (schema/functions) the user edits |
| Workspace pkg | `import … from "@lunora/<name>"` | Library code consumed as a versioned dependency  |

Many capabilities use both: a `@lunora/<name>` package holds the runtime and a
registry item scaffolds the glue (files under `lunora/<name>/`, bindings, env
vars). `auth`, `mail`, `ratelimit` and `storage` follow this pattern.

Skip this skill for a one-off feature in a single app (write it in `lunora/`),
or when the capability already exists (`lunora registry list`).

## Path A: registry item

An item is a directory `registry/<name>/` holding `registry.json`, the source
files it copies, and a `README.md`. Validate against
`registry/schema/registry-item.schema.json`.

```jsonc
// registry/<name>/registry.json
{
    "$schema": "../schema/registry-item.schema.json",
    "name": "<name>",
    "title": "Human Title",
    "description": "One-paragraph summary shown in `lunora registry list`.",
    "docs": "Post-install steps printed after `lunora registry add`.",
    "requires": [], // other items, installed first (e.g. auth-clerk requires auth)
    "deps": { "@lunora/server": "workspace:*" },
    "devDependencies": {},
    "bindings": [
        // structural edits applied to wrangler.jsonc
        { "path": ["d1_databases"], "value": [{ "binding": "DB", "database_name": "REPLACE_ME-db", "database_id": "<replace-with-d1-create-id>" }] },
    ],
    "envVars": [{ "name": "MY_SECRET", "description": "What it is and how to generate it.", "secret": true }],
    "files": [
        { "from": "schema.ts", "to": "lunora/<name>/schema.ts", "merge": "schema-extension" },
        { "from": "<name>.ts", "to": "lunora/<name>/index.ts", "merge": "create-or-skip" },
    ],
}
```

- `files[].merge`: `create-or-skip` writes whole files and never clobbers a file
  the user edited; `schema-extension` AST-merges into `lunora/schema.ts`.
- `envVars` land in `.dev.vars`. Non-secret vars get their `value`; secrets get
  an empty placeholder plus a `wrangler secret put <NAME>` reminder.
- `entrypointReexports` (`[{ "module": "_generated/workflows" }]`) injects
  `export * from './lunora/<module>'` into the worker entry of framework
  (class B/C) projects, for items whose generated classes the worker must
  export. No shipped item uses it yet.
- Function files import builders from `#lunora/_generated/server.js`, the
  module codegen emits in a consumer project. `registry/tsconfig.json` stubs
  that module so the item typechecks here.
- `deps` ranges are copied verbatim into the user's `package.json`. Use
  `workspace:*` for `@lunora/*` (resolved at publish); any other range must
  admit the version the workspace resolves, or `pnpm install` fails
  (`scripts/check-registry-catalog-ranges.js`).

Verify:

```bash
lunora registry build --from ./registry          # regenerate registry/index.json from the item dirs
lunora registry build --from ./registry --check  # CI: index is current
pnpm run lint:types:registry                     # tsc over every item (builds packages first)
pnpm run lint:registry:items                     # manifest + generated-deps tests
lunora registry view <name> --from <repo>/registry           # preview
lunora registry add <name> --from <repo>/registry --dry-run  # in a scratch app
```

`registry/index.json` is generated; do not hand-edit it.

## Path B: workspace package (Lunora monorepo)

```bash
vis generate lunora-package --name=search --description='Typed full-text search over Lunora tables' --category=add-on
```

Pass every option as `--name=value`; vis reads `--name search` as
`--name=true` plus a stray positional.

This writes `packages/search/` with `package.json` (ESM-only,
`"sideEffects": false`, catalog versions), `src/index.ts`, `tsconfig.json`,
`vitest.config.ts`, `packem.config.ts`, `eslint.config.js`,
`prettier.config.js`, `project.json` (tags `type:package` +
`category:<category>`), `.releaserc.json` and `README.md`. It does not create
`__tests__/` or `LICENSE.md`. Then:

1. `cp packages/config/LICENSE.md packages/search/LICENSE.md` (packem and
   `files` expect it).
2. Add a row to `.agents/docs/packages.md`, and list the directory in one tier
   of `scripts/api-snapshot.js` and the matching tier in `ROADMAP.md`. The
   `pnpm install` postinstall checks (`check-agents-md-packages`,
   `check-roadmap-tiers`) fail until both are done.
3. `pnpm install`, then add tests under `__tests__/`.

Repo conventions: relative imports without `.js`, named exports only (a
`default` only as a file's sole export), dependency versions via `catalog:*`
from `pnpm-workspace.yaml`.

Verify:

```bash
pnpm --filter "@lunora/search..." run build
pnpm --filter "@lunora/search" run lint:types
pnpm --filter "@lunora/search" run test
pnpm run lint:package-json
pnpm run api:update   # writes api-snapshots/search.api.md from the fresh build; commit it
```

## Wiring a `ctx.*` capability into codegen

Codegen decides which `ctx.*` fields exist by detecting usage, so a new
binding-backed helper is a row in `CAPABILITIES`
(`packages/codegen/src/capabilities.ts`): its package, `ctx` property, tier
(`"every"` or `"action"`-only), ctx type fragment, ShardDO binding, and
`defineApp` method. Rate the feature for every target in the
`PlatformCapabilities` matrices in `@lunora/platform`
(`packages/platform/src/capabilities/`) as `native`, `emulated` or
`unsupported` in the same change. A feature a target leaves unrated is dropped
from that target's generated surface with a diagnostic. Declaration-gated
surfaces (flags, notify, containers, workflows, queues, agents) have their own
emitters instead of a table row.

Document in the README any `lunora/*.ts` declaration the user must add for
codegen to emit the typed surface.
