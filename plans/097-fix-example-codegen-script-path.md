# Plan 097: Fix the broken `codegen` script path in all six examples

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> "STOP conditions" item occurs, stop and report. When done, update this plan's
> status row in `plans/README.md` unless a reviewer told you they maintain it.
>
> **Drift check (run first)**: `git diff --stat fc9c915b..HEAD -- examples`
> If any example `package.json` changed, re-read it before editing.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx / bug
- **Planned at**: commit `fc9c915b`, 2026-07-03

## Why this matters

All six example apps ship a `codegen` npm script pointing at
`node_modules/lunora/dist/bin.mjs`, but the umbrella package's npm name is
`lunorash` (the directory is `packages/lunora/` but `"name": "lunorash"` because
`lunora` is taken on npm). pnpm therefore links it as `node_modules/lunorash`,
and `node_modules/lunora` does not exist. Running `pnpm run codegen` (or `npm run
codegen`) in any example fails with `Cannot find module
'…/node_modules/lunora/dist/bin.mjs'`. Examples are canonical learning material —
a user copying the script into their own project inherits the broken path. This
is post-rename drift (a mechanical cirrus→lunora rename that produced `lunorash`
for the umbrella but left the script path on the old bare name).

## Current state

All six are identical (`examples/<name>/package.json:10`):

```json
"codegen": "node node_modules/lunora/dist/bin.mjs codegen",
```

Verified on disk: `examples/todo-app/node_modules/lunorash` is a symlink to
`../../../packages/lunora`, and `examples/todo-app/node_modules/lunora` does
**not** exist.

The six files:

- `examples/todo-app/package.json`
- `examples/auth-playground/package.json`
- `examples/blog/package.json`
- `examples/offline-rejections/package.json`
- `examples/payment-demo/package.json`
- `examples/realtime-cursors/package.json`

Note: examples still generate types via the `@lunora/vite` codegen plugin during
`dev`/`build`, so this is a dead standalone script, not a CI break — but it is
copy a user runs and copies.

Convention check — the templates use the bare bin (which works because the CLI
bin is linked): grep `templates/*/package.json` for `codegen` to confirm the
preferred form before choosing. If templates use `"lunora codegen"`, prefer that
(it exercises the linked `lunora` bin shim and matches what a user's own project
would use).

## Commands you will need

| Purpose              | Command                                         | Expected                    |
| -------------------- | ----------------------------------------------- | --------------------------- |
| Confirm the symlink  | `ls -l examples/todo-app/node_modules/lunorash` | points to `packages/lunora` |
| Confirm current form | `grep -n '"codegen"' examples/*/package.json`   | six matches on the old path |

## Scope

**In scope**: the six `examples/*/package.json` files listed above, `codegen`
script line only.

**Out of scope**: any other script in those files; the templates; the packages.

## Git workflow

- Branch: `advisor/097-fix-example-codegen-script-path`
- Commit: `fix(examples): point codegen script at lunorash bin`
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Decide the target form

Run `grep -n '"codegen"' templates/*/package.json`. If templates invoke bare
`lunora codegen`, use that form in the examples too (simplest, matches user
projects). If instead the examples must avoid relying on the linked bin, use
`node node_modules/lunorash/dist/bin.mjs codegen`. Prefer the bare `lunora
codegen` form unless the drift check shows examples deliberately avoid it.

### Step 2: Apply to all six

Change the `codegen` line in each of the six `examples/*/package.json` to the
chosen form.

**Verify**: `grep -n '"codegen"' examples/*/package.json` → six matches on the
new path, zero on `node_modules/lunora/dist`.

### Step 3: Smoke-test one example

In one example that has `node_modules` populated (e.g. `examples/todo-app`), run
the script and confirm it no longer throws the module-not-found error. If the
example's deps are not installed in this environment, skip the run and rely on
the path check — but note that in your report.

**Verify**: `cd examples/todo-app && pnpm run codegen` → completes without
`Cannot find module` (may print codegen output or a schema-not-found notice;
either is fine — the module resolves).

## Test plan

No unit tests (these are package.json scripts). The verification is the grep in
Step 2 plus the smoke run in Step 3.

## Done criteria

- [ ] `grep -rn 'node_modules/lunora/dist' examples/` returns no matches.
- [ ] All six `codegen` scripts use the chosen working form.
- [ ] `git status` shows only the six `examples/*/package.json` modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- The drift check shows an example already fixed or using a third form — reconcile, don't blindly overwrite.
- The smoke run fails with a _different_ error that suggests the bin form is wrong for examples (e.g. `lunora: command not found` because the bin isn't linked in examples) — fall back to the explicit `node_modules/lunorash/dist/bin.mjs` form and note it.

## Maintenance notes

- The rename left other stale `lunora`→`lunorash` references possible; a reviewer
  could grep the whole repo for `node_modules/lunora/` (trailing slash, not
  `lunorash`) to catch siblings, but that broader sweep is out of this plan's scope.
- If the umbrella is ever renamed again, these scripts and the templates must move together.
