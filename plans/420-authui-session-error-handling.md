# Plan 420: Treat an errored `getSession()` as an error in auth-ui, not as "signed out"

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report. Your reviewer maintains
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/auth-ui/src/core/session.ts packages/auth-ui/src/core/invitations.ts packages/auth-ui/src/core/profile.ts packages/auth-ui/src/core/verify-email.ts packages/auth-ui/src/core/active-member.ts`
> NOTE: the main checkout has uncommitted auth-ui edits from a concurrent
> session. You work in a fresh worktree from HEAD, which is what this plan was
> written against — but this drift check matters extra here: on ANY reported
> drift, compare the "Current state" excerpts before proceeding; on a
> mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW–MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

better-auth's client resolves `{ data, error }` rather than throwing, so a 5xx or network-shaped failure from `/get-session` lands as `data: null` with `error` set. Five `core/` sites read `getSession()` without the package's own `assertOk` guard, so an errored read is indistinguishable from "signed out": the session controller stores `status: "success", user: undefined` (UserButton flips to anonymous chrome, gated cards disappear); the invitation flow bounces an _already signed-in_ invitee to the sign-in screen mid-accept; the profile and verify-email prefills seed `""` — the exact anti-pattern `sign-up.ts`'s prefill documents and guards against; and `active-member` reports `status: "success"` with no role. Every _other_ client call in `core/` goes through `assertOk` (`map-error.ts:29-35`).

## Current state

All excerpts from committed HEAD (`git show HEAD:…`):

- `packages/auth-ui/src/core/session.ts:43-48`:
    ```ts
    const response = await context.authClient.getSession();
    // A signed-out user is a successful 200 with no user, not an error — ...
    store.update({ loading: false, settled: true, status: "success", user: response.data?.user });
    ```
    The comment shows the signed-out-200 case was considered; the errored-response case was not. The surrounding `try/catch` only catches throws, which the better-auth client does not produce for HTTP errors.
- `packages/auth-ui/src/core/invitations.ts:84-87`: `const session = await context.authClient.getSession(); if (!session.data?.user) { … nav.replace(sign-in) }` — an errored read bounces to sign-in.
- `packages/auth-ui/src/core/profile.ts:41-44` (prefill): returns `{ image: user?.image ?? "", name: user?.name ?? "" }` — blanks the settings form on a failed read.
- `packages/auth-ui/src/core/verify-email.ts:106-108` (prefill): `return { email: session.data?.user?.email ?? "" };` — same.
- `packages/auth-ui/src/core/active-member.ts:39-45`: `Promise.all([getSession(), getFullOrganization()])`, both unchecked, then `status: "success"`.
- The guard — `packages/auth-ui/src/core/map-error.ts:29-35`:
    ```ts
    const assertOk = <T>(response: AuthResponse<T>): AuthResponse<T> => {
        if (response.error) {
            throw new AuthActionError(response.error);
        }
        return response;
    };
    ```
- Prefill anti-blanking exemplar: `sign-up.ts:37-47` (documents why seeding `""` is wrong).

## Commands you will need

| Purpose       | Command                                             | Expected on success                                                                                         |
| ------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Install       | `pnpm install`                                      | exit 0                                                                                                      |
| Tests         | `pnpm --filter "@lunora/auth-ui" run test`          | all pass                                                                                                    |
| Typecheck     | `pnpm --filter "@lunora/auth-ui" run lint:types`    | exit 0 (runs 5 tsc/vue-tsc/svelte-check passes)                                                             |
| Lint          | `pnpm --filter "@lunora/auth-ui" run lint:eslint`   | exit 0                                                                                                      |
| Registry sync | `pnpm --filter "@lunora/auth-ui" run sync:registry` | exit 0                                                                                                      |
| Registry gate | `pnpm run lint:registry:sync`                       | exit 0                                                                                                      |
| API gate      | `pnpm run build:packages && pnpm run api:check`     | exit 0 (auth-ui has `api-snapshots/auth-ui.api.md`; run `api:update` only if it reports an intended change) |

## Scope

**In scope**:

- The five `core/` files above.
- Their existing test files under `packages/auth-ui/__tests__/` (core-level tests; find with `ls packages/auth-ui/__tests__`).
- `registry/auth-ui-*/` — via `sync:registry` only, never hand-edited.

**Out of scope**:

- Framework port files (`react/`, `vue/`, `solid/`, `svelte/`, `angular/`, …) — the state lives in `core/`; ports render `state.error` already. If a port lacks an error branch for one of these states, note it in your report; do not widen scope.
- `map-error.ts` — the guard is correct as-is.

## Git workflow

- Branch: shared wave branch `improve/wave22-auth-ui`.
- Commit: `fix(auth-ui): surface getSession errors as errors`

## Steps

### Step 1: session.ts

Wrap the read: `const response = assertOk(await context.authClient.getSession());` — the existing `catch` already maps to `status: "error"` via `mapAuthError`. Keep the signed-out-200 comment.

**Verify**: `pnpm --filter "@lunora/auth-ui" run test` → session tests pass (one may need updating if it stubbed an error response expecting signed-out — updating it is correct; say so in the commit body).

### Step 2: invitations.ts, active-member.ts

Same `assertOk` wrap. In `invitations.ts` the surrounding `try/catch` then renders the error state instead of bouncing; in `active-member.ts` wrap both calls in the `Promise.all`.

**Verify**: `pnpm --filter "@lunora/auth-ui" run test` → invitation/member tests pass.

### Step 3: profile.ts, verify-email.ts prefills

`assertOk` the read, and on a _present_ session return only present keys (omit a key rather than seeding `""` — follow `sign-up.ts:37-47`'s documented pattern). Check what the form controller does with an absent key vs `""` (read `create-form-controller.ts`'s prefill handling) and match it.

**Verify**: `pnpm --filter "@lunora/auth-ui" run test` → form/prefill tests pass.

### Step 4: Registry sync + gates

`pnpm --filter "@lunora/auth-ui" run sync:registry`, then `pnpm run lint:registry:sync` → exit 0. Then the api gate from the table.

## Test plan

Add one core test per changed controller (model on the existing core tests in `packages/auth-ui/__tests__/`): stub `getSession` to resolve `{ data: null, error: { status: 500, ... } }` and assert `status: "error"` (session, active-member), no navigation (invitations), and prefill rejection/propagation rather than `""` seeding (profile, verify-email).

## Done criteria

- [ ] `grep -n "await context.authClient.getSession()" packages/auth-ui/src/core/*.ts` shows every hit wrapped in `assertOk(...)` (or via `.then(assertOk)`)
- [ ] `pnpm --filter "@lunora/auth-ui" run test` exits 0 with the new tests
- [ ] `lint:types` + `lint:eslint` exit 0
- [ ] `pnpm run lint:registry:sync` exits 0
- [ ] No files outside scope modified (registry/ changes come from the sync script only)

## STOP conditions

- The drift check reports changes in any in-scope file (concurrent session may have landed auth-ui work between plan-writing and execution) and the live code no longer matches the excerpts.
- A framework port renders nothing for `status: "error"` in one of these flows, making the fix a visible regression (blank card) — report which port/flow instead of adding port UI.

## Maintenance notes

- Any new `core/` controller that reads `getSession` must go through `assertOk`; reviewer should grep for bare `getSession()` calls in future auth-ui PRs.
