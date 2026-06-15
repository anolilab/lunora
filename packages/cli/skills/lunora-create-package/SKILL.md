---
name: lunora-create-package
description: Builds a reusable Lunora capability — either a registry item installed with
    `lunora registry add`, or a publishable `@lunora/*` workspace package. Use for
    packaging schema + functions + bindings others can drop into their app.
---

# Lunora Create Package

Package a reusable Lunora capability. There are two distribution shapes; pick
based on whether the capability is **copied into the user's `lunora/`** or
**imported as a dependency**.

| Shape             | Distribution                     | Use for                                                  |
| ----------------- | -------------------------------- | -------------------------------------------------------- |
| **Registry item** | `lunora registry add <name>`     | App-owned code (schema/functions) the user edits + wires |
| **Workspace pkg** | `import … from "@lunora/<name>"` | Reusable library code imported as a dependency           |

Many capabilities use **both**: a thin `@lunora/<name>` package holding the
reusable runtime, plus a registry item that scaffolds the glue (`lunora/<name>/`
files, bindings, env vars) into the user's project. `auth`, `mail`, `ratelimit`,
and `storage` all follow this pattern.

## When to Use

- Extracting schema + functions you have written into something reusable.
- Authoring a new capability (presence, search, payments, …) for other apps.
- Adding a new item to this repo's `registry/`.

## When Not to Use

- A one-off feature for a single app — just write it in `lunora/`.
- The capability already exists as a registry item or `@lunora/*` package — use
  it (`lunora registry list` to browse).

## Path A: Registry Item

A registry item is a directory under `registry/<name>/` with three files:

- `registry.json` — the manifest (deps, bindings, env vars, files, requires).
- `index.ts` (and any siblings) — the code copied into the user's project.
- `README.md` — install + configuration docs.

### Manifest shape

```jsonc
// registry/<name>/registry.json
{
    "$schema": "../schema/registry-item.schema.json",
    "name": "<name>",
    "title": "Human Title",
    "description": "One-paragraph summary shown in `lunora registry list`.",
    "docs": "Post-install steps surfaced to the user after `lunora registry add`.",
    "requires": [], // other item names this one depends on
    "deps": { "@lunora/server": "workspace:*" },
    "bindings": [
        // reconciled into wrangler.jsonc
        { "path": ["d1_databases"], "value": [{ "binding": "DB", "database_name": "REPLACE_ME-db", "database_id": "<replace-with-d1-create-id>" }] },
    ],
    "envVars": [{ "name": "MY_SECRET", "description": "What it is and how to generate it.", "secret": true }],
    "files": [{ "from": "index.ts", "to": "lunora/<name>/index.ts", "merge": "create-or-skip" }],
}
```

- `files[].merge` is typically `create-or-skip` (never clobber edited user code);
  `bindings` are reconciled into `wrangler.jsonc`; `envVars` are scaffolded into
  `.dev.vars` (secret-looking ones get generated values).
- `requires` lets a provider item (e.g. `auth-clerk`) build on a base item
  (`auth`). The resolver installs the chain.

### Register and validate

Add an entry to `registry/index.json`, then rebuild and check the index:

```bash
lunora registry build              # regenerate registry/index.json
lunora registry build --check      # verify the index is up to date (CI)
lunora registry view <name>        # preview what `add` would do
lunora registry add <name>         # install into the current project
```

## Path B: Workspace Package

Scaffold a fresh `@lunora/<name>` package with the generator (always use the
`--name=value` form):

```bash
vis generate lunora-package --name=search --description='Typed full-text search over Lunora tables'
```

This creates `packages/search/` following the repo's package shape: `src/index.ts`,
`__tests__/`, `vitest.config.ts`, `tsconfig.json` (extends `../../tsconfig.base.json`),
`project.json` (vis tags `type:package` + `category:<slug>`), `package.json` (ESM,
`"sideEffects": false`, conditional exports), and `.releaserc.json`.

### Repo conventions to honor

- **No `.js` extensions** in relative imports (`moduleResolution: "bundler"`).
  The lone exception is `@lunora/codegen`'s emitted output.
- **No mixed default + named exports** in one file — named-only when there is
  more than one export.
- **Use the dependency catalogs** in `pnpm-workspace.yaml` (`catalog:test`,
  `catalog:lint`, …) — never hard-code a version that lives in a catalog.
- Tag `project.json` with `type:package` and a `category:<slug>`.

Build and test the new package in isolation:

```bash
pnpm --filter "@lunora/search" run lint:types
pnpm --filter "@lunora/search" run test
```

## Codegen-Wired Capabilities

If your capability surfaces functions on a context (e.g. `ctx.ai`, `ctx.containers`)
or new generated tables, it must be discoverable by `@lunora/codegen` — codegen
parses `lunora/schema.ts` and the function files. Document any `lunora/*.ts`
declaration the user must add so codegen wires the typed surface.

## Checklist

- [ ] Chose the right shape (registry item, workspace package, or both).
- [ ] Registry item: `registry.json` + `index.ts` + `README.md` authored;
      `bindings`/`envVars`/`requires`/`files` correct.
- [ ] `lunora registry build` run; `lunora registry build --check` passes.
- [ ] Workspace package: scaffolded via `vis generate lunora-package`; no `.js`
      extensions, no mixed default+named exports, catalog versions used.
- [ ] `lint:types` and `test` pass for the new package.
- [ ] README documents install, bindings, env vars, and any `lunora/` glue.
