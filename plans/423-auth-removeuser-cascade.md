# Plan 423: Cascade `removeUser` over plugin tables the way `deleteOrganization` already does

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report. Your reviewer maintains
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/auth/src/admin.ts packages/auth/__tests__/admin.behaviour.test.ts`
> On any change, compare the "Current state" excerpts; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug (data retention)
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`removeUser` (`packages/auth/src/admin.ts:1061-1065`) deletes sessions then calls `internalAdapter.deleteUser`, which in the installed better-auth (1.6.25) removes only `session`, `account`, and `user` rows. Nothing unwinds plugin tables, so deleting a user orphans `member`, `teamMember`, `passkey`, and `twoFactor` rows — the `twoFactor` leftovers hold the **TOTP secret and backup codes for an account that no longer exists** (a data-retention problem, not just untidiness), and orphaned `member` rows keep a deleted user counted against org membership limits. The same file already solves this class for organizations: `deleteOrganization` (`admin.ts:709-736`) explicitly unwinds members → invitations → teams → team members → roles with the comment "FK cascade may be off (D1), so unwind … explicitly", gating each table on `getAuthTables` presence. The same reasoning applies to users and was not applied.

## Current state

- `packages/auth/src/admin.ts:1061-1065`:
    ```ts
    removeUser: ({ userId }) =>
        withContext(async (context_) => {
            await context_.internalAdapter.deleteUserSessions(userId);
            await context_.internalAdapter.deleteUser(userId);
        }),
    ```
- The exemplar — `admin.ts:709-736` (`deleteOrganization`): `const tables = getAuthTables(context_.options);` then guarded `context_.adapter.deleteMany({ model: "...", where: [...] })` per table, with `if (tables["team"]) { … }`-style gates.
- Existing test: `packages/auth/__tests__/admin.behaviour.test.ts:181-188` asserts only that the `user` row is gone.

## Commands you will need

| Purpose    | Command                                        | Expected on success |
| ---------- | ---------------------------------------------- | ------------------- |
| Install    | `pnpm install`                                 | exit 0              |
| Build deps | `pnpm --filter "@lunora/auth..." run build`    | exit 0              |
| Tests      | `pnpm --filter "@lunora/auth" run test`        | all pass            |
| Typecheck  | `pnpm --filter "@lunora/auth" run lint:types`  | exit 0              |
| Lint       | `pnpm --filter "@lunora/auth" run lint:eslint` | exit 0              |

## Scope

**In scope**:

- `packages/auth/src/admin.ts` (the `removeUser` op only)
- `packages/auth/__tests__/admin.behaviour.test.ts`

**Out of scope**:

- `deleteOrganization` — the exemplar.
- better-auth's `deleteUser` internals; any schema change.
- Rows that reference the user only informationally (e.g. audit log entries) — the audit trail must survive user deletion by design.

## Git workflow

- Branch: shared wave branch `improve/wave22-auth`.
- Commit: `fix(auth): cascade plugin tables in removeUser`

## Steps

### Step 1: Add the guarded cascade

In `removeUser`, before the two existing calls, mirror `deleteOrganization`'s shape:

```ts
const tables = getAuthTables(context_.options);
```

then, each gated `if (tables["<model>"])` and scoped strictly to the user:

- `member` where `userId`
- `teamMember` where `userId`
- `passkey` where `userId`
- `twoFactor` where `userId`
- `invitation` where `inviterId` = userId (invitations the user _sent_; invitations addressed to their email stay — they're keyed by email, not user)

Verify each model name and where-field against `getAuthTables`' output / the schema in `packages/auth/src/schema.ts` before writing (the field on `twoFactor` may be `userId` — confirm; if a table keys differently, use its actual field).

**Verify**: `pnpm --filter "@lunora/auth" run lint:types` → exit 0.

### Step 2: Tests

Extend the `removeUser` test (model on the `deleteOrganization` cascade test if one exists, else on `admin.behaviour.test.ts:181-188`): create a user, give them a member row, a twoFactor row, and a sent invitation (whatever the harness supports — check how neighbouring tests seed plugin tables; if a table cannot be seeded in the harness, cover the ones that can and list the gap in NOTES), then `removeUser` and assert each seeded row is gone. Also: a deployment WITHOUT the organization plugin (tables absent) still removes the user cleanly — assert no throw.

**Verify**: `pnpm --filter "@lunora/auth" run test` → all pass including new cases.

## Test plan

Covered in Step 2 — cascade assertions per table plus the plugin-absent case.

## Done criteria

- [ ] `removeUser` shows the guarded cascade (read the diff)
- [ ] `pnpm --filter "@lunora/auth" run test` exits 0 with the new tests
- [ ] `lint:types` + `lint:eslint` exit 0
- [ ] No files outside scope modified

## STOP conditions

- `getAuthTables(context_.options)` does not expose one of the models above under the expected key (plugin table naming may differ) — report the actual keys rather than guessing a mapping.
- The harness cannot create a user with plugin rows at all — report; don't ship the cascade untested.
- Current-state excerpts don't match live code.

## Maintenance notes

- When a new better-auth plugin with user-keyed rows is adopted (e.g. api-key), its table must be added here; reviewer should ask that question on any PR adding a plugin.
- Deliberately NOT deleted: audit log rows (forensics) and invitations addressed to the user's email (email-keyed).
