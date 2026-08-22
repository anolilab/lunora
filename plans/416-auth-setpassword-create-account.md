# Plan 416: Make `setUserPassword` create the credential account when the user has none, and 404 unknown users

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. Your reviewer
> maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/auth/src/admin.ts packages/auth/__tests__/admin.behaviour.test.ts`
> On any change, compare the "Current state" excerpts against live code; on a
> mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

The Studio admin plane's `setUserPassword` (`packages/auth/src/admin.ts:1092-1108`) validates length, hashes, then calls `internalAdapter.updatePassword(userId, hashed)` unconditionally and reports success. better-auth's `updatePassword` is an `updateMany` on the `account` table filtered by `providerId: "credential"` (verified in the installed `better-auth@1.6.25` `dist/db/internal-adapter.mjs:538-547`) — zero matching rows is a **silent no-op**. So setting a password for an OAuth-only user, a user created without a password (`createUser` at `admin.ts:928-940` only links a credential account `if (password !== undefined && password !== "")`), or a nonexistent userId reports success while the user still cannot sign in. better-auth's own admin endpoint (`dist/plugins/admin/routes.mjs`, `set-user-password` handler) 404s an unknown user and **creates** the credential account when none exists; Lunora's replacement dropped both branches.

## Current state

- `packages/auth/src/admin.ts:1092-1108`:
    ```ts
    setUserPassword: ({ newPassword, userId }) =>
        withContext(async (context_) => {
            const min = context_.password.config.minPasswordLength;
            const max = context_.password.config.maxPasswordLength;
            // ...length checks throwing PASSWORD_TOO_SHORT / PASSWORD_TOO_LONG...
            const hashed = await context_.password.hash(newPassword);
            await context_.internalAdapter.updatePassword(userId, hashed);
        }),
    ```
- The credential-link shape this repo already uses — `admin.ts:932-940` (inside `createUser`):
    ```ts
    await context_.internalAdapter.linkAccount({
        issuer: createLocalAccountIssuer("credential"),
        password: hashed,
        providerAccountId: user.id,
        providerId: "credential",
        userId: user.id,
    });
    ```
- Upstream reference behaviour (installed `better-auth@1.6.25`, `dist/plugins/admin/routes.mjs` `setUserPassword` handler): `findUserById` → 404 `USER_NOT_FOUND`; then `findAccounts(userId)` → if a `providerId === "credential"` account exists, `updatePassword`, else `createAccount`.
- Errors on this plane are `LunoraAuthAdminError(message, code)` — see the throws at `admin.ts:1098,1102`. Check the code union/type near the `LunoraAuthAdminError` definition; add `"USER_NOT_FOUND"` if it is not already a valid code.
- Existing test coverage: `packages/auth/__tests__/admin.behaviour.test.ts:127-133` asserts only the too-short rejection.

## Commands you will need

| Purpose                                                     | Command                                         | Expected on success                                         |
| ----------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------- |
| Install                                                     | `pnpm install`                                  | exit 0                                                      |
| Build deps                                                  | `pnpm --filter "@lunora/auth..." run build`     | exit 0                                                      |
| Tests                                                       | `pnpm --filter "@lunora/auth" run test`         | all pass                                                    |
| Typecheck                                                   | `pnpm --filter "@lunora/auth" run lint:types`   | exit 0                                                      |
| Lint                                                        | `pnpm --filter "@lunora/auth" run lint:eslint`  | exit 0                                                      |
| API gate (only if the error-code union is exported surface) | `pnpm run build:packages && pnpm run api:check` | exit 0 (run `api:update` if it reports the intended change) |

## Scope

**In scope**:

- `packages/auth/src/admin.ts` (the `setUserPassword` op; the `LunoraAuthAdminError` code union if `USER_NOT_FOUND` must be added)
- `packages/auth/__tests__/admin.behaviour.test.ts`

**Out of scope**:

- `createUser` — its conditional credential link is correct.
- better-auth internals, `packages/auth/src/auth-do.ts`, session handling.

## Git workflow

- Branch: shared wave branch `improve/wave22-auth` (your dispatcher creates it).
- Commit: `fix(auth): create credential account in setUserPassword`

## Steps

### Step 1: Add the user-exists guard and the create-or-update branch

In `setUserPassword`, after the length checks and hash:

1. `const user = await context_.internalAdapter.findUserById(userId);` — if falsy, `throw new LunoraAuthAdminError("user not found", "USER_NOT_FOUND")` (match the existing message style; add the code to the union if needed).
2. `const accounts = await context_.internalAdapter.findAccounts(userId);` — if one has `providerId === "credential"`, keep the existing `updatePassword` call; otherwise call `context_.internalAdapter.linkAccount({...})` with **exactly** the shape `createUser` uses at `admin.ts:932-940` (issuer via `createLocalAccountIssuer("credential")`, `providerAccountId: userId`, `providerId: "credential"`, `password: hashed`, `userId`).

**Verify**: `pnpm --filter "@lunora/auth" run lint:types` → exit 0.

### Step 2: Tests

In `admin.behaviour.test.ts`, model on the existing `setUserPassword` too-short test and the `createUser` tests:

1. Create a user WITHOUT a password via the admin `createUser`, call `setUserPassword`, then assert a credential account row exists for the user (query the adapter/table the way neighbouring tests do) and sign-in with the new password succeeds if the harness supports it (otherwise asserting the credential row's presence + password field set is enough).
2. `setUserPassword` for a made-up userId rejects with `USER_NOT_FOUND`.
3. Existing behaviour: a user WITH a credential account gets its password updated (no second account row).

**Verify**: `pnpm --filter "@lunora/auth" run test` → all pass including 3 new tests.

## Test plan

Covered in Step 2 — three cases: no-credential-account create path, unknown-user 404, existing-account update path.

## Done criteria

- [ ] `pnpm --filter "@lunora/auth" run test` exits 0 with the new tests
- [ ] `pnpm --filter "@lunora/auth" run lint:types` and `lint:eslint` exit 0
- [ ] `setUserPassword` no longer calls `updatePassword` unconditionally (read the diff)
- [ ] No files outside scope modified (`git status`)

## STOP conditions

- The `internalAdapter` on this better-auth version lacks `findUserById` or `findAccounts` (check `node_modules/.pnpm/better-auth@*/node_modules/better-auth/dist/db/internal-adapter.mjs`) — report instead of substituting raw adapter queries.
- `linkAccount` with the `createUser` shape fails at runtime in tests (would indicate the 1.6/1.7 field-name comment in `createUser` is version-sensitive) — report which shape the installed version accepts.
- Current-state excerpts don't match live code.

## Maintenance notes

- If the repo upgrades better-auth majors, re-check `linkAccount`'s field names (`accountId` vs `providerAccountId`) — `createUser` and this op must move together.
- Reviewer: confirm the new `USER_NOT_FOUND` error code surfaces correctly through the Studio's error display (same channel as `USER_ALREADY_EXISTS`).
