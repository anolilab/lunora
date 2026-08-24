# Plan 419: Share the auth base-path boundary predicate so DO mode stops swallowing `/api/authorize`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report. Your reviewer maintains
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/auth/src/do-wiring.ts packages/auth/src/handler.ts`
> On any change, compare the "Current state" excerpts; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

With DO-backed auth, `do-wiring.ts` forwards any request whose pathname merely _string-prefixes_ the base path into the auth Durable Object: `if (!new URL(request.url).pathname.startsWith(basePath)) return undefined;` (`packages/auth/src/do-wiring.ts:132`). So app routes like `/api/authorize`, `/api/auth-callback`, or `/api/authors` (base `/api/auth`) are captured, the DO's `handleAuthRequest` correctly declines them, and the DO answers `404 {"error":"not an auth route"}` (`auth-do.ts:311-326`) — the app worker never sees the request. The D1-mode counterpart (`handler.ts:20-30`) already implements the correct segment-boundary + trailing-slash-normalized predicate, with a comment explaining exactly why the naive form is wrong. The two auth modes disagreeing about what "an auth route" is is the class of bug `do-wiring.ts`'s own module doc says it exists to prevent.

## Current state

- `packages/auth/src/do-wiring.ts:129-137`:
    ```ts
    authHandler: async (request) => {
        // Only auth routes go to the object; everything else falls through...
        if (!new URL(request.url).pathname.startsWith(basePath)) {
            return undefined;
        }
        return stub()?.fetch(request);
    },
    ```
- The correct predicate — `packages/auth/src/handler.ts:24-29`:
    ```ts
    const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;

    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) {
        return undefined;
    }
    ```

## Commands you will need

| Purpose                               | Command                                         | Expected on success                                                  |
| ------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| Install                               | `pnpm install`                                  | exit 0                                                               |
| Build deps                            | `pnpm --filter "@lunora/auth..." run build`     | exit 0                                                               |
| Tests                                 | `pnpm --filter "@lunora/auth" run test`         | all pass                                                             |
| Typecheck                             | `pnpm --filter "@lunora/auth" run lint:types`   | exit 0                                                               |
| Lint                                  | `pnpm --filter "@lunora/auth" run lint:eslint`  | exit 0                                                               |
| API gate (new export from handler.ts) | `pnpm run build:packages && pnpm run api:check` | exit 0 (run `pnpm run api:update` to accept the intended new export) |

## Scope

**In scope**:

- `packages/auth/src/handler.ts` — extract + export the predicate (e.g. `isAuthRoutePath(pathname, basePath)`), keep `handleAuthRequest` calling it.
- `packages/auth/src/do-wiring.ts` — call the shared predicate.
- Tests: the handler/do-wiring test files (find: `ls packages/auth/__tests__ | grep -iE "handler|wiring|do"`).
- `api-snapshots/auth.api.md` via `pnpm run api:update` (new export).

**Out of scope**:

- `auth-do.ts` — its 404 fallback is correct once routing is fixed.
- Any change to `DEFAULT_AUTH_BASE_PATH` or route matching inside better-auth.

## Git workflow

- Branch: shared wave branch `improve/wave22-auth`.
- Commit: `fix(auth): segment-match base path in DO wiring`

## Steps

### Step 1: Extract the predicate in handler.ts

Pull the two lines shown above into an exported helper (named export, no default — repo convention), keep the explanatory comment with it, and have `handleAuthRequest` use it.

**Verify**: `pnpm --filter "@lunora/auth" run test` → existing handler tests still pass.

### Step 2: Use it in do-wiring.ts

Replace the bare `startsWith` with the helper. Keep the "everything else falls through" comment.

**Verify**: `pnpm --filter "@lunora/auth" run lint:types` → exit 0.

### Step 3: Tests

Add cases (model on the existing handler boundary tests if present, else on any `do-wiring` test): with base `/api/auth` — `/api/authorize` → `undefined` (falls through), `/api/auth` → forwarded, `/api/auth/get-session` → forwarded, base `"/api/auth/"` (trailing slash) → `/api/auth/get-session` still forwarded.

**Verify**: `pnpm --filter "@lunora/auth" run test` → all pass including new cases.

### Step 4: API snapshot

`pnpm run build:packages && pnpm run api:update` — the new export appears in `api-snapshots/auth.api.md`; commit the snapshot with the change.

**Verify**: `pnpm run api:check` → exit 0.

## Test plan

Covered in Step 3; four boundary cases, both modes exercised through their public entry points where the harness allows.

## Done criteria

- [ ] `grep -n "startsWith(basePath)" packages/auth/src/do-wiring.ts` → no matches
- [ ] `pnpm --filter "@lunora/auth" run test` exits 0 with the new boundary tests
- [ ] `pnpm run api:check` exits 0
- [ ] No files outside scope modified

## STOP conditions

- `do-wiring.ts`'s `basePath` turns out to be shaped differently from `handler.ts`'s (e.g. always normalized upstream) such that sharing the predicate changes DO-mode behaviour for a currently-working path — report with the call-site evidence.
- Current-state excerpts don't match live code.

## Maintenance notes

- Reviewer: check no other `startsWith(basePath)` sites exist in the package (`grep -rn "startsWith(base" packages/auth/src`).
