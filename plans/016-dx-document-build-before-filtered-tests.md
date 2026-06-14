# Plan 016: Document that filtered per-package tests need a build first

> **Executor instructions**: Follow step by step; verify; obey STOP conditions;
> update `plans/README.md` when done. This plan edits docs only.
>
> **Drift check**: `git diff --stat 151a3eca..HEAD -- CLAUDE.md`
> Reconcile the "Build & Test Commands" section on change; mismatch ⇒ STOP.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW (docs only)
- **Depends on**: none
- **Category**: dx / docs
- **Planned at**: commit `151a3eca`, 2026-06-14

## Why this matters

Workspace `dist/` directories are gitignored and built on demand. Running a
single package's tests with `pnpm --filter "@cirrus/<pkg>" run test` does **not**
rebuild that package's workspace dependencies, so when an upstream package's
source has changed but its `dist/` is stale, tests fail with confusing runtime
errors like `X is not a function` and `lint:types` reports missing exports — even
though the source is correct. (This exact trap produced false "broken build"
reports during a recent audit.) `vis affected`/`test:affected` handle dep builds;
the raw `--filter` form does not. A short docs note saves real debugging time.

## Current state

`CLAUDE.md` → "## Build & Test Commands" lists, among others:

```
# Single package (use pnpm --filter)
pnpm --filter "@cirrus/runtime" run test
pnpm --filter "@cirrus/runtime" run lint:types
```

with no mention that a build of dependencies may be required first.

## Commands

| Purpose                       | Command                               | Expected               |
| ----------------------------- | ------------------------------------- | ---------------------- |
| Markdown lint (if configured) | `pnpm run lint:prettier` (check mode) | exit 0 (or unaffected) |

(There is no code to typecheck for a docs change.)

## Scope

**In scope**: `CLAUDE.md` (the "Build & Test Commands" section). Optionally
`CONTRIBUTING.md` if it exists and documents the same workflow
(`ls CONTRIBUTING.md`).
**Out of scope**: changing any `package.json` script (do NOT add a `pretest`
build hook — it would slow every run and is a larger decision); the vis config.

## Steps

### Step 1: Add a note under the single-package commands

In `CLAUDE.md`'s "Build & Test Commands", right after the
`# Single package (use pnpm --filter)` block, add:

```markdown
> Note: `dist/` is gitignored and built on demand. A raw `pnpm --filter … run
test` / `lint:types` does NOT rebuild workspace dependencies, so if an upstream
> `@cirrus/*` package's source changed you may hit stale-`dist` errors
> (`X is not a function`, "missing export"). Build first — `pnpm run
build:packages` once, or `pnpm --filter "@cirrus/<pkg>..." run build` (the
> trailing `...` includes dependencies) — or use `pnpm run test:affected` /
> `pnpm run lint:affected:types`, which build dependencies for you.
```

Verify the `--filter "@cirrus/<pkg>..."` dependency syntax is correct for this
repo's pnpm version before documenting it: run
`pnpm --filter "@cirrus/react..." run build` once and confirm it builds
dependencies. If that syntax does not work here, document only the
`pnpm run build:packages` and `test:affected` options.

**Verify**: re-read the edited section; ensure it renders as valid Markdown.

### Step 2: Mirror to CONTRIBUTING if applicable

If `CONTRIBUTING.md` exists and has a build/test section, add the same note
there. Otherwise skip.

## Done criteria

- [ ] `CLAUDE.md` documents the build-before-filtered-test caveat with a verified
      command
- [ ] If present, `CONTRIBUTING.md` carries the same note
- [ ] `git status` shows only docs files
- [ ] `plans/README.md` updated

## STOP conditions

- The "Build & Test Commands" section no longer matches the excerpt.
- The `--filter "@cirrus/<pkg>..."` syntax does not actually build deps in this
  repo (then document only the verified alternatives).

## Maintenance notes

- If the repo later adds `pretest`/`prebuild` hooks that auto-build deps, this
  note can be removed.
