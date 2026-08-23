# Plan 411: Put a first test suite under `lunora sdk generate`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/cli/src/commands/sdk/`
> On any change, compare the "Current state" excerpts against the live code
> before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/410-cli-sdk-vendor-symlink-guard.md (only ordering: 410 may change `copyEntry`; land 410 first so this suite tests the guarded behaviour. If executing on the same branch, do 410 before 411.)
- **Category**: tests
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`lunora sdk generate` (507 lines across `handler.ts`, `vendor.ts`, `stamp.ts` in `packages/cli/src/commands/sdk/`, shipped 2026-08-11) writes generated files into the user's project and fetches a transport over the network — and has **zero** tests (`ls packages/cli/__tests__/commands/ | grep -i sdk` → nothing), while every comparable file-writing command (registry resolve/reconcile/symlink-guard, import sources, zip-entry-stream) has a suite. The riskiest logic is the fallback-ref path: giget "succeeds" with an empty directory when a subdir is absent at a ref, and `carriesTransport`/`vendorAtRef` exist specifically to catch that measured-in-the-wild failure — untested, a regression would ship "a generated surface with no transport under it".

## Current state

- `packages/cli/src/commands/sdk/handler.ts` — `execute` flow: subcommand check → `--lang` validation against `SDK_TARGETS` → `sourceGateError` (blocked `--source` throws before anything is written) → read + validate OpenRPC document (`:40-46`: throws `BAD_REQUEST` when no `methods` array) → empty-`methods` warning at `:81-88` ("declares no methods — writing an empty SDK", deliberately continues) → `generateSdk` → `vendorTransport` FIRST, then `writeStamp(outputDirectory, language, vendored)`, then generated files, then an `untypedResults` count warning.
- `packages/cli/src/commands/sdk/vendor.ts:111` — `carriesTransport(directory, target)` (`target.vendor.every(entry => existsSync(...))`); `:118-140` — `vendorAtRef` returns `undefined` when the transport is absent at a ref (logged warn), so the caller retries an older ref; a real fetch failure still throws. `--from <dir>` is the offline seam (no network).
- Test seams that already exist: `--from` for a local transport directory, injectable `logger` via `defineHandler`, `--spec` and `--out` paths.
- Exemplar test to model on: `packages/cli/__tests__/commands/registry-symlink-guard.test.ts` (temp-dir setup + command invocation shape) and the other `packages/cli/__tests__/commands/*.test.ts` files for how handlers are driven (read 2–3 first; follow the dominant pattern for invoking a command handler with `{ argument, cwd, logger, options }`).

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

- `packages/cli/__tests__/commands/sdk.test.ts` (create)
- `packages/cli/__tests__/__fixtures__/` (a minimal OpenRPC fixture + a fake transport directory, following wherever existing command tests keep fixtures — check `ls packages/cli/__tests__/` for the convention first)

**Out of scope**:

- Any `src/` change. If a test reveals a bug, STOP and report it — this plan is tests-only.
- Network-dependent tests. Everything runs through `--from`.

## Git workflow

- Branch: `improve/wave22-cli`
- Commit: `test(cli): cover lunora sdk generate end to end`

## Steps

### Step 1: Fixtures

A minimal OpenRPC document fixture (2 methods: one with a typed `result.schema`, one without — so the `untypedResults` warning path is countable) and one empty-methods variant (`{"methods": []}` plus whatever envelope `readOpenRpcDocument` requires — read it). A fake transport directory whose files match the chosen language's `target.vendor` entries (read `SDK_TARGETS` to pick the smallest target — python's vendor list — and mirror its `from` paths with 1-line files, plus one `foo.test.py`-style file to assert the test-file filter).

**Verify**: fixtures exist; `pnpm --filter "@lunora/cli" run lint:eslint` → exit 0.

### Step 2: The suite

`sdk.test.ts`, driving the handler in a temp cwd, asserting:

1. **Happy path** (`--from <fake transport>`): output directory contains the vendored files (test-file filtered out) + generated files; the stamp file records the language and the vendored list (read `stamp.ts` for its exact shape and assert on real keys).
2. **Empty methods**: logger received the "declares no methods — writing an empty SDK." warning and the command still exits successfully with the transport vendored.
3. **Invalid spec**: a JSON file with no `methods` array → throws `BAD_REQUEST` naming the path.
4. **Unknown language**: `--lang cobol` → throws with the supported-language list.
5. **Missing transport in `--from`**: a `--from` directory missing a `target.vendor` entry → the command fails without writing generated surface files (assert the output dir has no generated files), matching the "transport FIRST" ordering in `handler.ts`.

(Case 5 exercises the same `carriesTransport` predicate the network fallback uses — the fallback-ref loop itself stays untested here because it needs the network; note that in a comment.)

**Verify**: `pnpm --filter "@lunora/cli" run test -- sdk` (or the repo's filter syntax — check how other single-file runs are done in `packages/cli/package.json` scripts) → 5 tests pass.

### Step 3: Full suite green

**Verify**: `pnpm --filter "@lunora/cli" run test` → all pass.

## Test plan

The 5 cases above; structural model = existing `packages/cli/__tests__/commands/` handler tests.

## Done criteria

- [ ] `packages/cli/__tests__/commands/sdk.test.ts` exists with ≥5 passing tests
- [ ] `pnpm --filter "@lunora/cli" run test` exits 0
- [ ] `pnpm --filter "@lunora/cli" run lint:types` and `lint:eslint` exit 0
- [ ] No `src/` file modified (`git status`)

## STOP conditions

- The handler cannot be driven without network access even with `--from` (read the `vendorTransport` `from` branch first — if `--from` still hits giget, report instead of mocking the network).
- A test exposes a real defect in the sdk command — report it; do not fix in this plan.
- The fixture-directory convention in `packages/cli/__tests__` is materially different from assumed — follow the convention, and note the deviation.

## Maintenance notes

- When a new SDK language target is added, extend case 1's fixture or parameterize over targets.
- Reviewer: check the assertions read real file contents/stamp keys, not just existence.
