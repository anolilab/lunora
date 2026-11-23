# Plan 613: Admin API-key revoke reports failure when it did not revoke

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 093c5e41f..HEAD -- packages/auth/src/admin.ts packages/runtime/src/auth-admin-routes.ts packages/auth/__tests__/admin.api-keys.behaviour.test.ts packages/auth/docs/plugins.mdx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `093c5e41f` (2026-11-20)
**Status:** DONE, pushed: `fix/auth-banned-identity-and-key-revoke`; PR #1634
**As implemented:** superseded by plan 663. `deleteApiKey` decides from each `apiKey()` configuration's storage mode, not from `context_.secondaryStorage`, and a missing row answers `API_KEY_STORAGE_UNSUPPORTED` (409), not `API_KEY_NOT_FOUND`, whenever a configuration keeps keys outside the database. The Design and Step 1 below describe the first version.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (touches the same package as plan 611; run after it, on the same branch, to avoid conflicts)
- **Category**: security
- **Planned at**: commit `093c5e41f`, 2026-11-20
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

The Studio's "Revoke" button and `deleteAuthApiKey` call the admin operation `deleteApiKey`. It deletes the `apikey` row by id and the HTTP route always answers `{ ok: true }` — also when no row matched, and also when the app stores keys in better-auth _secondary storage_, where (a) with `fallbackToDatabase` the cached copy keeps verifying after the row is gone, and (b) without it there is no row at all. During an incident an operator revokes a leaked key, sees success, and the key still works. The operation must either really revoke or say it did not.

## Current state

- `packages/auth/src/admin.ts` — `createAuthAdmin`. `deleteApiKey` at ~line 1100:

```ts
        // Deletes the row directly, like the other admin ops. That revokes the key only
        // while the `apikey` table is the store, the default `storage: "database"`. Under
        // secondary storage better-auth keeps keys elsewhere and this does not reach them.
        deleteApiKey: ({ apiKeyId }) =>
            withContext(async (context_) => {
                await context_.adapter.delete({ model: "apikey", where: [{ field: "id", value: apiKeyId }] });
            }),
```

- Error type in the same file: `class LunoraAuthAdminError extends LunoraError` (line 435), thrown as `new LunoraAuthAdminError("user not found", "USER_NOT_FOUND")` (lines 1124, 1331). Find the union of codes its second argument accepts (`rg -n "USER_NOT_FOUND" packages/auth/src/admin.ts` and read the type near line 435).
- `packages/runtime/src/auth-admin-routes.ts` — maps admin errors to HTTP: line ~757 reads `candidate.code`, line 769 throws `new LunoraError("auth admin operation failed", { code, status: AUTH_ADMIN_ERROR_STATUS[code] ?? 500 })`. `AUTH_ADMIN_ERROR_STATUS` is a code→status table in that file. The route (line 395) is `{ http: "POST", method: "deleteApiKey", returns: "void" }`.
- How better-auth's api-key plugin (1.7.16, read-only) lays out secondary storage — it writes three entries per key and deletes them on its own delete endpoint:

```js
// @better-auth/api-key dist/index.mjs, deleteApiKeyFromStorage
(storage.delete(getStorageKeyByHashedKey(apiKey.key)), storage.delete(getStorageKeyById(apiKey.id)), storage.delete(refKey)); // getStorageKeyByReferenceId(apiKey.referenceId)
```

Those key-name helpers are private to the plugin; **do not re-implement their string formats.**

- `context_.secondaryStorage` is better-auth's configured secondary storage (or `undefined`). Check how this file already reads it: `rg -n "secondaryStorage" packages/auth/src`.
- Docs, `packages/auth/docs/plugins.mdx` "**Revocation.**" paragraph ends: "The studio's Revoke deletes the row directly, which needs the default `storage: "database"`; with secondary storage, revoke through better-auth's own endpoint."
- Existing test: `packages/auth/__tests__/admin.api-keys.behaviour.test.ts`, case "revokes one key by id and leaves the owner's other keys in place" — has `seedDatabase()`, `buildAdmin(database, plugins)`, `keyRow(id, referenceId)`.

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

Run everything from the repo (worktree) root. `dist/` is not committed, so build the package and its workspace dependencies once before testing or type-checking.

| Purpose                       | Command                                                                                                                        | Expected on success |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                                                                               | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/auth..." run build`                                                                                    | exit 0              |
| One test file                 | `pnpm --filter "@lunora/auth" exec vitest run __tests__/admin.api-keys.behaviour.test.ts`                                      | all pass            |
| Package tests                 | `pnpm --filter "@lunora/auth" run test`                                                                                        | all pass            |
| Types                         | `pnpm --filter "@lunora/auth" run lint:types`                                                                                  | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/auth" run lint:eslint`                                                                                 | exit 0, 0 warnings  |
| Runtime route tests           | `pnpm --filter "@lunora/runtime..." run build && pnpm --filter "@lunora/runtime" exec vitest run __tests__/auth-admin.test.ts` | all pass            |

## Design (decided — do not re-litigate)

Fail closed, do not reach into the plugin's private storage layout:

1. Unknown id → throw `LunoraAuthAdminError("api key not found", "API_KEY_NOT_FOUND")` → HTTP 404.
2. Secondary storage configured on the auth instance (`context_.secondaryStorage !== undefined`) → throw `LunoraAuthAdminError("api keys are held in secondary storage; revoke through better-auth's api-key endpoint", "API_KEY_STORAGE_UNSUPPORTED")` → HTTP 409, **before** deleting anything. Rationale: with secondary storage present the plugin may be serving the key from a cache this operation cannot name, so a row delete would be a silent partial revoke. (An app that configures secondary storage for sessions only but keeps `apiKey({ storage: "database" })` is also refused; that is the conservative side and the docs say so.)
3. Otherwise delete the row.

## Scope

**In scope**:

- `packages/auth/src/admin.ts` (the `deleteApiKey` op and the error-code union)
- `packages/runtime/src/auth-admin-routes.ts` (two entries in `AUTH_ADMIN_ERROR_STATUS`)
- `packages/auth/__tests__/admin.api-keys.behaviour.test.ts`
- `packages/runtime/__tests__/auth-admin.test.ts` (one case, if the status table is asserted there)
- `packages/auth/docs/plugins.mdx` (the Revocation paragraph)
- `api-snapshots/auth.api.md` / `api-snapshots/runtime.api.md` **only** if the error-code union is part of the public snapshot (step 4)

**Out of scope**: the Studio UI (`packages/studio/**`) — it already surfaces a failed admin call as an error toast; `packages/client/**`; anything in `node_modules`.

## Git workflow

- Branch: `fix/538-revoke-api-key-fails-closed` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Example from this repo: `fix(auth): address API key review comments`. Use: `fix(auth): fail closed when an API key revoke does nothing`.
- Never use `--no-verify`. Do NOT push or open a PR.

## Steps

### Step 1: make `deleteApiKey` fail closed

Rewrite the op per the Design: `findOne` the row by id first (`context_.adapter.findOne({ model: "apikey", where: [{ field: "id", value: apiKeyId }] })`), check secondary storage, then delete. Add the two codes to the error-code union. Replace the three-line comment with one that states the invariant ("never report a revoke that left a verifying copy behind").

**Verify**: `pnpm --filter "@lunora/auth" run lint:types` → exit 0.

### Step 2: map the codes to HTTP statuses

In `AUTH_ADMIN_ERROR_STATUS` (`auth-admin-routes.ts`) add `API_KEY_NOT_FOUND: 404` and `API_KEY_STORAGE_UNSUPPORTED: 409`, keeping the table's existing key order convention (read the table first; it is likely alphabetical).

**Verify**: `pnpm --filter "@lunora/runtime..." run build` then `pnpm --filter "@lunora/runtime" run lint:types` → exit 0.

### Step 3: tests

In `admin.api-keys.behaviour.test.ts` add:

1. "refuses an unknown key id" — `await expect(adminApi.deleteApiKey({ apiKeyId: "nope" })).rejects.toMatchObject({ code: "API_KEY_NOT_FOUND" })`, and the seeded rows are untouched.
2. "refuses to revoke when secondary storage is configured, and deletes nothing" — build the auth with `secondaryStorage: { get: async () => null, set: async () => undefined, delete: async () => undefined }` passed to `createAuth` alongside the memory adapter; seed `k1`; expect rejection with `API_KEY_STORAGE_UNSUPPORTED`; assert `database["apikey"]` still has `k1`.
   The existing "revokes one key by id" case must still pass unchanged.

If `packages/runtime/__tests__/auth-admin.test.ts` has a table-driven test of error statuses, add the two codes there in the same style.

**Verify**: both test files pass. **Verify red**: revert step 1, rerun → the two new auth tests fail. Restore.

### Step 4: docs and API snapshot

- Replace the last sentence of the Revocation paragraph with: "The studio's Revoke deletes the row directly. It answers `API_KEY_NOT_FOUND` for an id that does not exist, and refuses with `API_KEY_STORAGE_UNSUPPORTED` when the auth instance has secondary storage configured, because a cached copy of the key could keep verifying; revoke through better-auth's own endpoint in that setup."
- Run `pnpm --filter "@lunora/auth" run build && pnpm --filter "@lunora/runtime" run build && pnpm run api:check`. If it reports a diff limited to the new error codes, run `pnpm run api:update` and commit the snapshot change. Any other diff is a STOP.

## Done criteria

- [ ] `pnpm --filter "@lunora/auth" run test` and `pnpm --filter "@lunora/runtime" exec vitest run __tests__/auth-admin.test.ts __tests__/named-admin-tokens.test.ts` exit 0
- [ ] `lint:types` and `lint:eslint` exit 0 for `@lunora/auth` and `@lunora/runtime`
- [ ] `pnpm run api:check` exits 0
- [ ] `rg -n "API_KEY_NOT_FOUND|API_KEY_STORAGE_UNSUPPORTED" packages/auth/src packages/runtime/src` shows both codes in both packages
- [ ] `git status --short` lists only in-scope files

## STOP conditions

- Excerpts do not match (note: `deleteApiKey` was added on branch `feat/api-key-auth`; if the file has no such op, you are on the wrong base — stop).
- `context_.secondaryStorage` is not how the auth context exposes secondary storage in this better-auth version.
- The error-code union is closed in a way that needs changes in a third package.
- `api:check` shows changes beyond the two codes.

## Maintenance notes

- If better-auth later exports its storage-key helpers or a server-side "delete key by id" API, replace the refusal with a real secondary-storage revoke.
- Reviewer: check nothing is deleted on the refusal path, and that the 404 does not leak whether a key id exists to a caller without the admin token (the route checks the admin bearer first — unchanged).
