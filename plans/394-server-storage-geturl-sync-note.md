# Plan 394: Document and pin `storageRules`' one synchronous guarded method (`getUrl`)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/server/src/storage/middleware.ts`
> On a mismatch with the "Current state" excerpts, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

The `storageRules` wrapper in `packages/server/src/storage/middleware.ts` is a security boundary: it allowlists guarded methods and wraps each as `(...args) => { assertAllowed(...); return original(...args); }`. Every wrapped method returns a `Promise` — except `getUrl`, which is declared `(key: string) => string` and returns synchronously. The wrapper's return type is `unknown`, so this asymmetry is invisible to the compiler, and a future refactor that adds an `await`/`async` around the wrapping loop would silently change `ctx.storage.getUrl`'s contract from `string` to `Promise<string>` for guarded procedures only. The code is correct today; the fix is one documentation sentence plus one test that pins the synchronous return, so the invariant fails loudly if a refactor breaks it.

## Current state

- `packages/server/src/storage/middleware.ts:52` — `getUrl?: (key: string) => string;` — the only non-Promise member of `WrappableStorage` (siblings at :50-53 all return Promises).
- `packages/server/src/storage/middleware.ts:97-105` — `GUARDED_METHODS` pairs `["getUrl", "read"]`.
- `packages/server/src/storage/middleware.ts:155-167` — the wrapping loop; `wrapped[method] = (...args: unknown[]): unknown => { ...; return (original as ...)(...args); }` — passes the sync return through untouched.
- `packages/server/src/storage/middleware.ts:24-29` — the module doc explains the allowlist rationale but never mentions the sync member.
- Test file: find with `ls packages/server/__tests__ | grep -i storage` (the finding referenced `storage-rules.test.ts`).

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `pnpm install` | exit 0 |
| Build deps | `pnpm --filter "@lunora/server..." run build` | exit 0 |
| Tests     | `pnpm --filter "@lunora/server" run test` | all pass |
| Typecheck | `pnpm --filter "@lunora/server" run lint:types` | exit 0 |
| Lint      | `pnpm --filter "@lunora/server" run lint:eslint` | exit 0 |

## Scope

**In scope**:
- `packages/server/src/storage/middleware.ts` (comment only — no behaviour change)
- The storage-rules test file (one new test)

**Out of scope**:
- Changing `getUrl` to async, changing the wrapper's types, or any behaviour change — this plan documents and pins, nothing more.

## Git workflow

- Branch: `improve/wave22-server`
- Commit: `docs(server): pin storageRules getUrl sync contract`

## Steps

### Step 1: The comment

In the module doc (or directly above the `getUrl` line in `WrappableStorage`), add: `getUrl` is the one **synchronous** member of the guarded surface — the wrapper must keep returning its value directly; wrapping this loop in `async`/`await` would silently turn `ctx.storage.getUrl` into a Promise for guarded procedures only.

**Verify**: `pnpm --filter "@lunora/server" run lint:eslint` → exit 0 (comment formatting).

### Step 2: The pin

In the storage-rules test file, add a test: wrap a stub storage whose `getUrl` returns `"https://x/y"`; call `wrapped.getUrl("allowed-key")` and assert `typeof result === "string"` (NOT a thenable — also assert `result` has no `.then`). Model on the file's existing allow-path tests.

**Verify**: `pnpm --filter "@lunora/server" run test -- storage` → all pass including the new test.

## Test plan

The single pin test above; the rest of the storage-rules suite unchanged.

## Done criteria

- [ ] The comment exists at the `getUrl` declaration or module doc
- [ ] The sync-return pin test exists and passes
- [ ] `pnpm --filter "@lunora/server" run test` exits 0; `lint:types` + `lint:eslint` exit 0
- [ ] Zero behaviour change (`git diff` shows only comments + test)

## STOP conditions

- The wrapping loop has been refactored to async since the excerpt (the hazard already fired) — report; the fix is then behavioural, not documentary.

## Maintenance notes

- If `getUrl` is ever made async upstream (storage adapter change), delete the pin test in the same change and update the comment — the pin exists to force exactly that conversation.
