# Plan 574 — `removeMember` and `updateMemberRole` refuse to orphan an organization

**Baseline:** `79b0c5a6a` (2026-11-11)
**Status:** TODO

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. If anything in "STOP conditions" (section 8)
> occurs, stop and report; do not improvise. Do not edit `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 79b0c5a6a..HEAD -- packages/auth/src/admin.ts packages/auth/__tests__/admin.behaviour.test.ts packages/auth/__tests__/admin.orgs.behaviour.test.ts packages/runtime/src/auth-admin-routes.ts packages/runtime/__tests__/auth-admin.test.ts`
> Empty output expected; otherwise compare section 1 with the live code and STOP on a mismatch.

Finding row 35 of the 2026-11-11 audit (issue #1527).

## 0. Headline finding

`createAuthAdmin` refuses `removeUser` for the last owner of an organization, but `removeMember`
deletes the member row unconditionally and `updateMemberRole` can demote the only owner. Either
leaves an organization nobody can administer. `removeMember` also leaves the user's `teamMember`
rows for that organization's teams behind. In the Studio, the existing refusal code
`LAST_ORGANIZATION_OWNER` surfaces as HTTP 500 because the runtime route has no status for it.

## 1. Current state (audit)

- `packages/auth/src/admin.ts` — the admin plane.
    - Line 564: `const isOwnerRole = (role: unknown): boolean => typeof role === "string" && role.includes("owner");`
    - Lines 566-605: `assertNotLastOwner(context_, userId)` — finds the user's owner memberships,
      loads each organization's roster with `context_.adapter.findMany({ model: "member", where:
[{ field: "organizationId", value }] })`, and throws
      `new LunoraAuthAdminError("user is the last owner of organization … — transfer ownership or delete the organization first", "LAST_ORGANIZATION_OWNER")`
      when no OTHER member of that organization holds an owner role.
    - Lines 962-974, `updateMemberRole`:

        ```ts
        updateMemberRole: ({ memberId, role }) =>
            withContext(async (context_) => {
                const member = await context_.adapter.update<Record<string, unknown>>({
                    model: "member",
                    update: { role: serializeRole(role) },
                    where: [{ field: "id", value: memberId }],
                });
                // … returns normalizeRow(member ?? { id: memberId, role: serializeRole(role) })
            }),
        ```

    - Lines 1259-1262, `removeMember`:

        ```ts
        removeMember: ({ memberId }) =>
            withContext(async (context_) => {
                await context_.adapter.delete({ model: "member", where: [{ field: "id", value: memberId }] });
            }),
        ```

    - Lines 1272-1289, `removeUser`: calls `getAuthTables(context_.options)` and only runs
      `assertNotLastOwner` when `tables["member"]` exists. Same gating pattern applies here.
    - `serializeRole` (line 506) joins an array role with commas.
    - `removeTeam` (lines 951-955) shows the team-member delete call shape:
      `context_.adapter.deleteMany({ model: "teamMember", where: [{ field: "teamId", value: teamId }] })`.
      `teamMember` rows carry `teamId` and `userId`; `team` rows carry `organizationId`.
- `packages/runtime/src/auth-admin-routes.ts` lines 243-252: `AUTH_ADMIN_ERROR_STATUS` maps
  client-input codes to 4xx (`ORG_SLUG_TAKEN: 409`, `USER_NOT_FOUND: 404`, …); an unmapped code is a 500. `LAST_ORGANIZATION_OWNER` is not in it.
- Tests:
    - `packages/auth/__tests__/admin.behaviour.test.ts` lines 370-409: the `removeUser` guard tests
      (memory adapter + `organization()` plugin). Use them as the pattern.
    - `packages/auth/__tests__/admin.orgs.behaviour.test.ts` lines 126-184: existing
      `updateMemberRole` / `removeMember` tests. They create organizations WITHOUT an owner and plain
      `member` roles, so the new guard must not affect them. Lines ~330-415 build a database with
      `team` / `teamMember` tables (teams enabled) — the pattern for the team cleanup test.
    - `packages/runtime/__tests__/auth-admin.test.ts` line 256: "maps a known client-input code to its
      4xx and an unmapped backend failure to 500" — the pattern for the status mapping test.

## 2. Existing seams (do not reinvent)

- `isOwnerRole`, `LunoraAuthAdminError`, `getAuthTables`, `withContext`, the memory-adapter test
  setup. Copy the `LunoraAuthAdminError(message, code)` argument order from `assertNotLastOwner`.

## 3. The behavioural contract to preserve

- `removeUser`'s guard and message stay as they are.
- Every existing test in the three auth/runtime test files passes unchanged.
- `removeMember` on a non-owner, or on an owner when another owner remains, deletes the row exactly
  as today. `updateMemberRole` between non-owner roles, or adding owner, behaves exactly as today.
- Public types of `AuthAdmin` do not change (they are in `api-snapshots/auth.api.md`).

## 4. Design decisions

- **Per-organization guard.** Add a helper (e.g. `assertOrganizationKeepsOwner(context_,
organizationId, memberId)`) that loads that organization's roster and throws the same code
  `LAST_ORGANIZATION_OWNER` when no member OTHER than `memberId` holds an owner role. Rejected:
  reusing `assertNotLastOwner(userId)`, which checks every organization the user owns, so removing
  a user from org A would be refused because they are the sole owner of org B.
- **`removeMember` loads the row first** (`findOne` on `member` by `id`). A row that does not exist
  keeps today's behaviour (the delete is a no-op; return without error). Only an owner-role row runs
  the guard.
- **`updateMemberRole`** runs the guard only when the member currently holds an owner role and the
  new serialized role does not.
- **Team cleanup:** after deleting the member, when `tables["teamMember"]` and `tables["team"]`
  exist, find the organization's teams and, per team, `deleteMany` the `teamMember` rows with that
  `teamId` AND the member's `userId` (a two-entry `where` array is an AND). Rejected: an `in`
  operator, which not every adapter supports.
- **Runtime status:** add `LAST_ORGANIZATION_OWNER: 409` to `AUTH_ADMIN_ERROR_STATUS` (a conflict
  with the organization's current state, like `ORG_SLUG_TAKEN`). This also fixes `removeUser`'s
  refusal reading as a 500 in the Studio.

## 5. Workstreams

One workstream, size S. One commit, type `fix`, scope `auth`.

### Commands you will need

| Purpose           | Command (worktree root)                                                                                                 | Expected |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- | -------- |
| Install           | `pnpm install --frozen-lockfile`                                                                                        | exit 0   |
| Build deps once   | `pnpm --filter "@lunora/auth..." run build && pnpm --filter "@lunora/runtime..." run build`                             | exit 0   |
| Auth test file    | `pnpm --filter "@lunora/auth" exec vitest run __tests__/admin.behaviour.test.ts __tests__/admin.orgs.behaviour.test.ts` | all pass |
| Runtime test file | `pnpm --filter "@lunora/runtime" exec vitest run __tests__/auth-admin.test.ts`                                          | all pass |
| Package tests     | `pnpm --filter "@lunora/auth" run test` then `pnpm --filter "@lunora/runtime" run test`                                 | all pass |
| Format            | `pnpm exec oxfmt <each changed .ts file>`                                                                               | exit 0   |
| ESLint            | `pnpm --filter "@lunora/auth" run lint:eslint` and `pnpm --filter "@lunora/runtime" run lint:eslint`                    | exit 0   |
| Types             | `pnpm --filter "@lunora/auth" run lint:types` and `pnpm --filter "@lunora/runtime" run lint:types`                      | exit 0   |

### Scope

**In scope:** `packages/auth/src/admin.ts`, `packages/auth/__tests__/admin.behaviour.test.ts`,
`packages/runtime/src/auth-admin-routes.ts`, `packages/runtime/__tests__/auth-admin.test.ts`.

**Out of scope:** `packages/auth-ui/**` and `registry/**` (their UI calls the same endpoints and
needs no change), `packages/auth/src/middleware.ts`, any exported type, `plans/README.md`.

### Git workflow

- Branch `fix/improve-574-auth-last-owner`, cut from `origin/alpha`. Do not push.
- One commit: `fix(auth): guard the last owner in removeMember and updateMemberRole`; body ≤ 4
  lines (≤ 100 chars each) naming the 409 mapping; last line
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Stage explicit paths. Never `git add -A`, `git commit -a`, any `git stash`, `--no-verify`.

### Executor rules

- Work only inside your worktree; absolute paths or `cd <worktree> &&` in every shell call.
- Never run `pnpm run test:workerd`, `pnpm run build:packages`, `pnpm run build`, repo-root
  `pnpm run test`, or `pnpm -r …`. Never kill a process by pattern.
- oxfmt before ESLint. No `.js` import extensions. Named exports only. Comments say why.
- Tests await results, never timers. No `.skip`, `@ts-expect-error`, `as any`, or new
  `eslint-disable` without a rule name and `-- reason` on one line.

### Step 1: Install and build

**Verify:** both commands exit 0.

### Step 2: Write the failing tests

In `packages/auth/__tests__/admin.behaviour.test.ts`, beside the `removeUser` guard tests (line
370), using the same `orgDatabase` + `createAuth({ … plugins: [admin(), organization()] })` setup:

1. `removeMember` of the sole owner is refused with `/LAST_ORGANIZATION_OWNER|last owner/iu`, and
   the `member` table still has the row.
2. `updateMemberRole` demoting the sole owner to `"member"` is refused the same way, and the row's
   role is still the owner role.
3. With a second owner added (`addMember({ organizationId, role: "owner", userId })`), both calls
   succeed.
4. Removing an owner from org A is allowed when another owner of A exists, even though the same user
   is the sole owner of org B (guards against the rejected design).
5. Team cleanup: with `team` and `teamMember` tables in the memory database and the organization
   plugin's teams enabled (copy the setup from `admin.orgs.behaviour.test.ts` around line 330),
   `removeMember` deletes that user's `teamMember` rows for the organization's teams and leaves a
   `teamMember` row for a team of ANOTHER organization intact.

In `packages/runtime/__tests__/auth-admin.test.ts`, next to the test at line 256, add a case where
the mocked admin method throws `new LunoraError("LAST_ORGANIZATION_OWNER", "…")` (same shape as the
`USER_NOT_FOUND` case) and assert status 409.

Run both test-file commands.

**Verify:** the new tests 1, 2, 4(if it removes), 5 and the runtime 409 test FAIL. Note which fail.
If test 1 and test 2 both pass, STOP.

### Step 3: Implement the guard and the cleanup in `admin.ts`

Per section 4. Keep the helper beside `assertNotLastOwner` with a doc comment saying why it is
per-organization. Gate the guard on `tables["member"]` like `removeUser` does.

**Verify:** auth test-file command → all pass.

### Step 4: Map the status

Add `LAST_ORGANIZATION_OWNER: 409` to `AUTH_ADMIN_ERROR_STATUS` in
`packages/runtime/src/auth-admin-routes.ts`, keeping the keys alphabetical.

**Verify:** runtime test-file command → all pass.

### Step 5: Gates, then commit

Format, ESLint and types for both packages, then both package test suites.

**Verify:** all exit 0. Commit. `git status --short` empty.

### Step 6: Prove the tests need the fix (after the commit; no stash)

```bash
git show 79b0c5a6a:packages/auth/src/admin.ts > packages/auth/src/admin.ts
git show 79b0c5a6a:packages/runtime/src/auth-admin-routes.ts > packages/runtime/src/auth-admin-routes.ts
pnpm --filter "@lunora/auth" exec vitest run __tests__/admin.behaviour.test.ts      # new tests FAIL
pnpm --filter "@lunora/runtime" exec vitest run __tests__/auth-admin.test.ts         # 409 test FAILS
git checkout HEAD -- packages/auth/src/admin.ts packages/runtime/src/auth-admin-routes.ts
git status --short   # empty
```

**Verify:** failures as noted; the tree is clean afterwards.

## 6. Platform parity

Not applicable: no `ctx.*` surface or binding.

## 7. Phasing & ordering

| Phase | Work      | Gate                                                                           |
| ----- | --------- | ------------------------------------------------------------------------------ |
| 0     | Steps 1-6 | new tests red on base, green with fix; both packages' lint, types, tests green |

## 8. Risks & STOP conditions

- **STOP** if section 1's excerpts do not match the live code.
- **STOP** if an existing test in `admin.orgs.behaviour.test.ts` fails because of the guard (it would
  mean those fixtures create owners; report which).
- **STOP** if the team cleanup needs an adapter operator other than equality.
- **Risk:** an owner role spelled without the substring `owner`. Mitigate: reuse `isOwnerRole`, the
  convention this file already uses.

## 9. Open questions

1. None.

## Done criteria

- [ ] `pnpm --filter "@lunora/auth" run test` and `pnpm --filter "@lunora/runtime" run test` exit 0.
- [ ] Lint (eslint) and types exit 0 for both packages.
- [ ] New tests fail against `79b0c5a6a`'s `admin.ts` / `auth-admin-routes.ts` (step 6).
- [ ] `git diff --stat 79b0c5a6a..HEAD` lists only the four in-scope files.
- [ ] `grep -n "LAST_ORGANIZATION_OWNER: 409" packages/runtime/src/auth-admin-routes.ts` matches.

## Maintenance notes

- Any new admin method that removes or demotes a member must run the per-organization guard.
- Hit-every-surface: the Studio, `auth-ui` and the HTTP admin routes all reach these two functions,
  so the guard lives in the function, not in a handler.
