# Plan 410: Refuse symlinks when vendoring an SDK transport

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/cli/src/commands/sdk/vendor.ts`
> On any change, compare the "Current state" excerpts against the live code
> before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`lunora sdk generate` vendors a transport directory fetched over giget (or from `--from`) into the user's project with `cpSync(..., { recursive: true })`, whose filter only skips test files. `cpSync` does not dereference symlinks by default, so a hostile or compromised source can plant `sdk/python/lunora/config.py -> ~/.ssh/id_rsa` (or a dangling link into `node_modules`) inside the user's project — anything that later reads/writes the generated SDK follows it. The registry copy-in path treats exactly this as a security bug and refuses symlinks with a dedicated guard and regression suite; the SDK path shipped without it.

## Current state

- `packages/cli/src/commands/sdk/vendor.ts:80-96` — `copyEntry`:
    ```ts
    cpSync(source, destination, {
        filter: (candidate) => !isTestFile(candidate.slice(candidate.lastIndexOf(sep) + 1)),
        force: true,
        recursive: true,
    });
    ```
- The exemplar stance to match — `packages/cli/src/commands/registry/reconcile.ts:44-49`:
    ```ts
    if (lstatSync(sourcePath).isSymbolicLink()) {
        throw new LunoraError("INTERNAL", `registry item "${itemKey}": refusing to read "${file.from}" — it is a symlink, not a regular file`);
    }
    ```
- Regression-test pattern: `packages/cli/__tests__/commands/registry-symlink-guard.test.ts`.

## Commands you will need

| Purpose    | Command                                       | Expected on success |
| ---------- | --------------------------------------------- | ------------------- |
| Install    | `pnpm install`                                | exit 0              |
| Build deps | `pnpm --filter "@lunora/cli..." run build`    | exit 0              |
| Tests      | `pnpm --filter "@lunora/cli" run test`        | all pass            |
| Typecheck  | `pnpm --filter "@lunora/cli" run lint:types`  | exit 0              |
| Lint       | `pnpm --filter "@lunora/cli" run lint:eslint` | exit 0              |

## Scope

**In scope**:

- `packages/cli/src/commands/sdk/vendor.ts`
- `packages/cli/__tests__/commands/` — new `sdk-vendor-symlink-guard.test.ts` (or extend the existing registry guard file if it is structured for multiple subjects — read it first and follow its shape)

**Out of scope**:

- `packages/cli/src/commands/registry/` — already guarded.
- The rest of `sdk/` (generate/handler logic) — plan 411 covers tests for those.

## Git workflow

- Branch: `improve/wave22-cli`
- Commit: `fix(cli): refuse symlinks when vendoring sdk transports`

## Steps

### Step 1: Refuse symlinks in `copyEntry`

In the `cpSync` filter, `lstatSync(candidate)` and **throw** a `LunoraError` (refuse-don't-skip, matching the registry's stance) when `.isSymbolicLink()`, message naming the offending relative path: `refusing to vendor "<path>" — it is a symlink, not a regular file`. Note: `cpSync`'s filter receives source paths; throwing from the filter aborts the copy — verify a partial copy is cleaned up or acceptable (the destination dir is the freshly-created output; a thrown error surfaces to the command which already reports failure — confirm by reading the caller in `vendor.ts`/`handler.ts`, and if a partial vendored tree would be left behind silently, wrap the copy so the output directory is removed on throw).

**Verify**: `pnpm --filter "@lunora/cli" run lint:types` → exit 0.

### Step 2: Regression test

Model on `registry-symlink-guard.test.ts`: build a temp transport directory containing one regular file and one symlink, run the vendor path against it via the `--from` seam, assert it throws with the symlink's path in the message and that the symlink does not exist in the output.

**Verify**: `pnpm --filter "@lunora/cli" run test` → all pass including the new one.

## Test plan

- The temp-dir symlink test above (skip on Windows the same way the registry guard test does, if it does — read it).

## Done criteria

- [ ] `pnpm --filter "@lunora/cli" run test` exits 0 with the new test
- [ ] `pnpm --filter "@lunora/cli" run lint:types` and `lint:eslint` exit 0
- [ ] `grep -n "isSymbolicLink" packages/cli/src/commands/sdk/vendor.ts` → at least one match
- [ ] No files outside the in-scope list modified (`git status`)

## STOP conditions

- The "Current state" excerpts don't match the live code.
- `cpSync`'s filter semantics make refuse-on-throw unreliable on the installed Node version (filter not called for some entry types) — fall back to a pre-walk with `lstatSync` before the copy, and report the deviation in NOTES.

## Maintenance notes

- Plan 411 adds the first test suite over `sdk generate`; if it lands after this, its fixture transport must contain only regular files.
- Reviewer: check the error path leaves no partial `sdk/<lang>` directory behind.
