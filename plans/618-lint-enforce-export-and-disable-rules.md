# Plan 618: ESLint enforces the export-shape and eslint-disable conventions the repo documents

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 093c5e41f..HEAD -- eslint.config.base.js examples/eslint.config.base.js packages/*/eslint.config.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `093c5e41f` (2026-11-20)
**Status:** PARTIAL, pushed: `build/guard-file-level-eslint-disable` (guard script, 1-entry baseline). The export conversions landed on alpha separately (#1539). Rule enforcement in ESLint waits on an owner decision, see the plan file; PR #1648

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `093c5e41f`, 2026-11-20
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Narrowed after the first execution (2026-11-20)

There is no shared local ESLint base: all 61 `packages/*/eslint.config.js` are self-contained `createConfig(...)` calls, each with a comment saying "Each package owns its own setup (no shared local preset)". That is a recorded repo decision, so Design items 1 to 3 (a shared rule block, the mixed-export `no-restricted-syntax` rule, `import/prefer-default-export` off everywhere) and the `eslint-comments` rules in item 4 are **not executed** and wait on the owner: either accept a shared rule file spread into all 61 configs, or put the rules into `@anolilab/eslint-config` itself.

Executed scope: the check script, baseline and CI step from Design 4, and the three mixed-export files from Design 5.

## Why this matters

The repo's AGENTS.md states two rules that nothing checks: (1) "Never mix a default export with named exports in the same file", and (2) "An `eslint-disable` is line-scoped and carries its reason … A file-level disable is not accepted." At the planned commit, 124 files under `packages/*/src` contain a file-level `/* eslint-disable ... */`, at least three source files mix a default with named exports, and one package's lint config enforces `import/prefer-default-export` with a comment that mis-states the convention while another turns the same rule off. Rules that rely on reviewers drift; this plan makes the linter hold the line for **new** code and records the existing violations as an explicit, shrinking baseline. It does **not** clean up the 124 files.

## Current state

- Each package has its own flat config `packages/<pkg>/eslint.config.js`. Find the shared base they import: `rg -n "import .* from" packages/client/eslint.config.js packages/auth/eslint.config.js | head` and `ls eslint.config.* examples/eslint.config.base.js`. The base preset is `@anolilab/eslint-config` (in `node_modules`, read-only); it disables `eslint-comments/no-unlimited-disable` and `eslint-comments/require-description` and enables `import/prefer-default-export`.
- `packages/studio/eslint.config.js:172-177`:

```js
    // The repo convention (AGENTS.md): a sole-export file exports `default`; files
    // with multiple exports use named-only. `import/prefer-default-export` (on via
    // the base config) enforces the single-export half, keeping import sites uniform.
    {
        rules: {
            "import/prefer-default-export": "error",
        },
    },
```

AGENTS.md actually says a default is _allowed_ only as a file's sole export — not required.

- `packages/client/eslint.config.js` (~line 116) turns `import/prefer-default-export` off.
- Mixed default + named files (confirmed): `packages/solid/src/shared-context.ts:68-69` (`export { sharedContextFor }; export default sharedContext;`), `packages/react/src/use-preloaded-query.ts:137-138` (`export { hydratePreloaded }; export default usePreloadedQuery;`), `packages/cli/src/util/lazy-smoke-load.ts:1209-1210` (`export { killWindowsTreeOnExit, taskkillEndedTree }; export default runLazySmokeLoad;`).
- Legitimate exception per AGENTS.md: a **Worker entry module** (the file `wrangler.jsonc`'s `main` points at, e.g. `lunora/server.ts`, `src/server/index.ts` in apps/examples/templates) must have a default plus named Durable Object exports.

### Repo conventions that apply (from the repo's AGENTS.md — you have not read it, so they are inlined)

- TypeScript, ESM, `"moduleResolution": "bundler"`: relative imports have **no** file extension (`from "./foo"`, never `"./foo.js"`).
- Never mix a default export with named exports in one file. More than one export ⇒ named only.
- This is a pre-release (`1.0.0-alpha.*`) line: do **not** keep backward-compat shims or deprecated aliases; change the behaviour and update every call site.
- Comments say _why_ (a constraint or invariant), never restate the code or record history.
- An `eslint-disable` must be line-scoped, name the rule, and give a reason after `--`. Never add a file-level disable. Never skip or silence a test, type error or lint rule to get green.
- Tests are Vitest, live in the package's `__tests__/`, and **wait on a milestone, never on a clock** (no `sleep`, no real `setTimeout` waits). Existing tests start with `expect.assertions(n)`; match that.
- **A test must fail without the fix.** After writing a test, temporarily revert your fix, run the test, confirm it goes red, then restore the fix. Report that you did this.
- If you fix by hand: run Prettier before ESLint.
- Never run `pnpm -r run test`, never `pnpm run test:workerd`, never `pnpm run build:packages` (other sessions share this machine; those have crashed it). Use the single-package commands below.
- Never kill a process by name/pattern. Never `git add -A` / `git commit -a` / `git stash`; stage explicit paths.

## Commands you will need

| Purpose                              | Command                                                                                | Expected |
| ------------------------------------ | -------------------------------------------------------------------------------------- | -------- |
| Install (fresh worktree)             | `pnpm install --frozen-lockfile`                                                       | exit 0   |
| Lint one package                     | `pnpm --filter "@lunora/<pkg>" run lint:eslint`                                        | exit 0   |
| Lint everything (slow; builds first) | `pnpm run lint:eslint`                                                                 | exit 0   |
| Tests of a touched package           | `pnpm --filter "@lunora/<pkg>..." run build && pnpm --filter "@lunora/<pkg>" run test` | pass     |
| Public API                           | `pnpm run api:check`                                                                   | exit 0   |

## Design (decided)

1. **One shared rule block** in the file every package config already extends (if there is no shared local base, create `eslint.config.shared-rules.js` at the repo root exporting an array of flat-config objects, and spread it into each package config — but prefer an existing base).
2. **Mixed exports**: a `no-restricted-syntax` entry with selector `Program:has(ExportDefaultDeclaration):has(ExportNamedDeclaration[exportKind!="type"])` and message "Do not mix a default export with named exports (AGENTS.md). Use named exports only." Type-only named exports beside a default are tolerated by this selector on purpose. Add an `ignores`/override for Worker entry files: `**/lunora/server.ts`, `**/src/server/index.ts`, `**/worker.ts` — verify the real entry names with `rg -n '"main"' --glob 'wrangler.jsonc' apps examples templates | head -30` and list exactly those patterns.
3. **`import/prefer-default-export`: off** in the shared block; delete the studio override and its comment, and delete the now-redundant per-package `off` and the inline `eslint-disable ... import/prefer-default-export` comments that become unused (ESLint's `--report-unused-disable-directives` / `linterOptions.reportUnusedDisableDirectives` will list them if enabled; otherwise `rg -n "import/prefer-default-export" packages/*/src`).
4. **File-level disables**: enable `eslint-comments/no-unlimited-disable` (error) and `eslint-comments/require-description` (error, `ignore: []`) — check the plugin's actual namespace in the base preset first (`@eslint-community/eslint-comments/...` vs `eslint-comments/...`). For _rule-specific_ file-level disables there is no stock rule; add a second `no-restricted-syntax`-free mechanism: a small check script `scripts/check-file-level-eslint-disable.js` (Node, no deps, same style as the other `scripts/check-*.js`) that lists files under `packages/*/src` and `shared/` containing a block `/* eslint-disable` with no matching `/* eslint-enable`, compares against a committed baseline `scripts/file-level-eslint-disable.baseline.json` (sorted array of paths), and exits 1 on any file **not** in the baseline, and also when a baseline entry no longer violates (so the baseline can only shrink). Wire it as `"lint:eslint-disable": "node scripts/check-file-level-eslint-disable.js"` in the root `package.json` scripts (keep key order — run `pnpm run lint:package-json`) and add it to the same CI workflow step list where `lint:package-json` runs in `.github/workflows/lint.yml`.
5. **Fix the three mixed-export source files** by converting the default to a named export and updating every import site (`rg -n "shared-context\"|use-preloaded-query\"|lazy-smoke-load\"" packages`). For `lazy-smoke-load.ts`, if a third-party loader requires a default, adapt at the call site with `.then((m) => ({ default: m.runLazySmokeLoad }))` (the repo's documented pattern).

## Scope

**In scope**: the shared ESLint base / package `eslint.config.js` files; the three source files in Design 5 and their import sites; `scripts/check-file-level-eslint-disable.js` + baseline (create); root `package.json` (one script); `.github/workflows/lint.yml` (one step); `api-snapshots/*.api.md` only if Design 5 changes a public export (then STOP — see below).

**Out of scope**: removing or rewriting any of the existing file-level disables (baseline only); `node_modules`; `apps/docs`; changing any other lint rule; `templates/`, `registry/` copies.

## Git workflow

- Branch: `fix/543-lint-export-disable-rules` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Example from this repo: `fix(auth): address API key review comments`. Use: `build(lint): enforce export shape and disable-comment rules`.
- Never use `--no-verify`. Do NOT push or open a PR.

## Steps

1. Read the config chain; write down where the shared block will live. **Verify**: `pnpm --filter "@lunora/client" run lint:eslint` exits 0 before any change (baseline is green).
2. Design 3 (prefer-default-export off, remove studio override, remove dead inline disables). **Verify**: `pnpm --filter "@lunora/studio" run lint:eslint` and `--filter "@lunora/values"` exit 0.
3. Design 5 (three files). **Verify**: build + test + lint `@lunora/solid`, `@lunora/react`, `@lunora/cli`; `pnpm run api:check`.
4. Design 2 (mixed-exports rule). **Verify**: `pnpm run lint:eslint` exits 0. Then prove the rule fires: temporarily add `export default 1;` to `packages/wire/src/index.ts`, run `pnpm --filter "@lunora/wire" run lint:eslint` → fails with the message; revert.
5. Design 4 (comment rules + script + baseline + CI step). **Verify**: `node scripts/check-file-level-eslint-disable.js` exits 0; add a file-level disable to a non-baseline file → exits 1; revert. `pnpm run lint:package-json` exits 0.

## Done criteria

- [ ] `pnpm run lint:eslint` exits 0
- [ ] `node scripts/check-file-level-eslint-disable.js` exits 0 and fails on a new violation (demonstrated in step 5)
- [ ] `rg -n "prefer-default-export" packages/*/eslint.config.js` → no matches
- [ ] `pnpm run api:check` and `pnpm run lint:package-json` exit 0
- [ ] Tests pass for solid, react, cli

## STOP conditions

- Enabling `no-unlimited-disable`/`require-description` produces more than ~30 errors repo-wide: do not fix them by hand — report the count and leave those two rules off, keeping the script.
- The mixed-exports selector flags more than ~10 non-entry files: report the list, add nothing to ignores beyond Worker entries.
- Design 5 changes a published export name (`api:check` diff on `react.api.md`/`solid.api.md`): STOP and report — renaming a public default export is a maintainer decision.
- The package configs do not share a local base and there are more than ~60 files to touch individually.

## Maintenance notes

- The baseline is meant to shrink: moving the `unicorn/prevent-abbreviations` exception for `ctx-db-*` filenames and the `no-secrets` false positives into config would retire ~70 entries in one change.
- Reviewer: check the Worker-entry ignore list is exact, not a broad glob.
