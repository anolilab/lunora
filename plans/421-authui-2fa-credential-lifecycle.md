# Plan 421: Clear 2FA credential fields on step transitions so the enable password cannot pre-satisfy disable

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report. Your reviewer maintains
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/auth-ui/src/core/two-factor-setup.ts packages/auth-ui/src/react/two-factor-setup-card.tsx`
> NOTE: the main checkout has uncommitted auth-ui edits from a concurrent
> session. You work in a fresh worktree from HEAD (what this plan was written
> against) — on ANY reported drift, compare the excerpts; on mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

The 2FA flow keeps the password typed for **enable** in shared core state across every later step. The disable form (rendered when `step === "enabled"`) binds the same `state.password`, and `disable()` validates only `required(state.password.value, …)` — so immediately after enrolling, "Disable 2FA" is one click away with **no re-authentication**: the password gate better-auth requires for disable is pre-satisfied by a value typed for a different action. Secondary issues: the plaintext account password stays bound to a live DOM input for the whole multi-step flow, and the one-time backup codes are rendered only in the `verify` step, so they vanish the instant `verify()` flips `step` to `"enabled"` — before the user necessarily saved them. The state lives in `core/`, so every framework port inherits all of it.

## Current state

All excerpts from committed HEAD:

- `packages/auth-ui/src/core/two-factor-setup.ts:70-73` — `enable` success:
    ```ts
    const { data } = assertOk(await context.authClient.twoFactor.enable({ password: state.password.value }));
    store.update({ backupCodes: data?.backupCodes ?? [], status: "idle", step: "verify", totpUri: data?.totpURI });
    ```
    `password` is left untouched.
- `two-factor-setup.ts:91-93` — `verify` success: `store.update({ status: "success", step: "enabled" });` — again `password`/`code` untouched, and `backupCodes`/`totpUri` remain in state.
- `two-factor-setup.ts:99-116` — `disable`: `required(state.password.value, …)` then `twoFactor.disable({ password: state.password.value })`; success does `store.set(initialState())` (the only full reset in the flow).
- `packages/auth-ui/src/react/two-factor-setup-card.tsx:47-63` — the `step === "enabled"` branch binds the disable form's password `Field` to `state.password`.
- `two-factor-setup-card.tsx:83-94` — backup codes render only inside the `step === "verify"` branch.
- The field helper: `two-factor-setup.ts` has an `emptyField()`-style initializer near the top (read the file's `initialState` for the exact name/shape).

## Commands you will need

| Purpose       | Command                                             | Expected on success                                     |
| ------------- | --------------------------------------------------- | ------------------------------------------------------- |
| Install       | `pnpm install`                                      | exit 0                                                  |
| Tests         | `pnpm --filter "@lunora/auth-ui" run test`          | all pass                                                |
| Typecheck     | `pnpm --filter "@lunora/auth-ui" run lint:types`    | exit 0                                                  |
| Lint          | `pnpm --filter "@lunora/auth-ui" run lint:eslint`   | exit 0                                                  |
| Registry sync | `pnpm --filter "@lunora/auth-ui" run sync:registry` | exit 0                                                  |
| Registry gate | `pnpm run lint:registry:sync`                       | exit 0                                                  |
| API gate      | `pnpm run build:packages && pnpm run api:check`     | exit 0 (`api:update` only for intended surface changes) |

## Scope

**In scope**:

- `packages/auth-ui/src/core/two-factor-setup.ts` (the fix — core only).
- Its core test file (find: `ls packages/auth-ui/__tests__ | grep -i two-factor`).
- `registry/auth-ui-*/` via `sync:registry` only.

**Out of scope**:

- Port files (`react/`, `svelte/`, …) — they bind whatever core holds; clearing the field in core fixes every port at once. Do NOT add per-port fields.
- A QR encoder, "I've saved these" acknowledgement UI, or any new UI surface — the minimal state fix below keeps codes visible without new components; anything more is a product decision, deferred.

## Git workflow

- Branch: shared wave branch `improve/wave22-auth-ui`.
- Commit: `fix(auth-ui): clear 2fa credentials across steps`

## Steps

### Step 1: Clear credentials on each successful transition

In `two-factor-setup.ts`:

- `enable` success: include `password: <empty field initializer>` in the `store.update` (the DOM input empties; the user must retype their password to disable).
- `verify` success: include `code: <empty field initializer>` and `totpUri: undefined` (the secret has served its purpose once TOTP is verified). Keep `backupCodes` **in state** so they remain visible.

### Step 2: Keep backup codes visible on the enabled step

Move `backupCodes` rendering out of the verify-only conditional in core's contract: the cheapest core-only shape is to leave `backupCodes` populated after `verify` (Step 1 already does) — then check whether the react port's `enabled` branch renders them. It does not (`two-factor-setup-card.tsx:48-63`). Since ports are out of scope for new UI, instead clear `backupCodes` ONLY on `disable` success (already covered by `store.set(initialState())`) and note in your report that surfacing codes on the enabled step is a port-side follow-up. Do not gate `verify()` on an acknowledgement.

### Step 3: Tests

In the two-factor core test file (model on its existing cases):

1. After a successful `enable`, `state.password.value === ""`.
2. After a successful `verify`, `state.code.value === ""` and `state.totpUri === undefined`, `state.backupCodes` still populated.
3. `disable()` immediately after enable+verify fails validation (password required) rather than calling the client — assert the client's `disable` was NOT invoked.

**Verify**: `pnpm --filter "@lunora/auth-ui" run test` → all pass including 3 new tests.

### Step 4: Registry sync + gates

`pnpm --filter "@lunora/auth-ui" run sync:registry` → `pnpm run lint:registry:sync` → exit 0. API gate per the table.

## Test plan

Covered in Step 3; the third case is the security regression test.

## Done criteria

- [ ] The 3 new core tests pass; full `pnpm --filter "@lunora/auth-ui" run test` exits 0
- [ ] `lint:types` + `lint:eslint` exit 0
- [ ] `pnpm run lint:registry:sync` exits 0
- [ ] No files outside scope modified

## STOP conditions

- Drift check reports in-scope changes and live code no longer matches the excerpts (concurrent auth-ui session).
- A port's test suite asserts the password field retains its value across steps (would mean the current behaviour is somewhere relied upon) — report, don't fight the test.

## Maintenance notes

- Follow-up (deferred, port-side): render `backupCodes` on the `enabled` step with an explicit "save these" acknowledgement; core now keeps them available for exactly that.
- Reviewer: confirm no port caches `totpUri` outside core state.
