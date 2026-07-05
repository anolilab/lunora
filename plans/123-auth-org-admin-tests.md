# Plan 123: Behavioral tests for the org/team admin surface in @lunora/auth

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat b6eb48dcd..HEAD -- packages/auth/src/admin.ts packages/auth/__tests__/admin.behaviour.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (additive tests only)
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `b6eb48dcd`, 2026-07-04

## Why this matters

`createAuthAdmin` in `packages/auth/src/admin.ts` gained ~18 organization/team
methods (createOrganization with owner seeding, add/remove member, member-role
update, invitations, teams, org roles, deleteOrganization with a cascade) that
back the Studio org-management UI through the admin-token-gated runtime
routes. This is an **authorization-critical surface** — membership and role
mutations — and it has essentially zero behavioral coverage: the only
org-related tests exercise better-auth's own plugin endpoint
(`plugins.behaviour.test.ts` "createOrganization persists a row and seeds the
owner membership"), not the `createAuthAdmin` wrapper methods the runtime
actually calls. Tellingly, the _user-side_ admin surface in the same file has
exactly the negative tests the org side lacks — including an explicit
cross-user IDOR test for `unlinkAccount`. A regression in, say,
`removeMember`'s where-clause would currently ship green.

## Current state

- `packages/auth/src/admin.ts` — the surface (signatures at lines 258-322,
  implementations from ~593). Representative implementations read at
  `b6eb48dcd`:

    ```ts
    removeMember: ({ memberId }) =>
        withContext(async (context_) => {
            await context_.adapter.delete({ model: "member", where: [{ field: "id", value: memberId }] });
        }),

    updateMemberRole: ({ memberId, role }) =>
        withContext(async (context_) => {
            const member = await context_.adapter.update<Record<string, unknown>>({
                model: "member",
                update: { role: serializeRole(role) },
                where: [{ field: "id", value: memberId }],
            });
            // A `null` result means the adapter didn't echo the row … synthesize
            return normalizeRow(member ?? { id: memberId, role: serializeRole(role) }) as AuthMember;
    ```

    Note for test design: `removeMember`/`updateMemberRole` are keyed by
    **memberId only** — a member row id is globally unique, so org-scoping is
    implicit in the id. The IDOR-shaped assertions below therefore target
    "wrong memberId does not affect other rows" and "operations land on exactly
    the addressed row", not a cross-org ownership check that the API does not
    express. If you believe a true cross-org confused-deputy exists (e.g. a
    caller can pass a memberId from another org while the _runtime route_
    implies an org context), record it as a finding in your report — do not
    redesign the API in this plan.

- The harness to extend — `packages/auth/__tests__/admin.behaviour.test.ts:1-45`:

    ```ts
    import { memoryAdapter } from "better-auth/adapters/memory";
    …
    const seedMemoryDatabase = (): Record<string, unknown[]> => {
        return { account: [], session: [], user: [], verification: [] };
    };

    describe("createAuthAdmin", () => {
        let database: Record<string, unknown[]>;
        let auth: any;
        let adminApi: ReturnType<typeof createAuthAdmin>;

        beforeEach(() => {
            database = seedMemoryDatabase();
            auth = createAuth({
                baseURL: "http://localhost",
                database: memoryAdapter(database),
                emailAndPassword: { enabled: true },
                plugins: [admin()],
                secret: SECRET,
            });
            adminApi = createAuthAdmin(auth);
        });
    ```

    Its 17 existing `it` blocks cover user ops only. The IDOR exemplar to mirror
    (line 230): "unlinkAccount scopes the delete to the owning user (no
    cross-user IDOR)" — creates a victim + attacker, passes the victim's
    accountId with the wrong userId, asserts the row survives.

- Org tables: the org plugin contributes `organization`, `member`,
  `invitation` (+ `team`, `teamMember` when teams are enabled) models. The
  memory adapter auto-creates arrays only for seeded keys — extend
  `seedMemoryDatabase` (or a local variant) with the org-model keys, and add
  the `organization(...)` plugin (import from `../src/plugins`, see
  `plugins.behaviour.test.ts:164+` for a working org-enabled `createAuth`
  setup, including any plugin options it passes).

Conventions: vitest with `expect.assertions(n)` at the top of each test
(match the file); no `.js` extensions in imports; enforced commit types
include `test`.

## Commands you will need

| Purpose      | Command                                                       | Expected on success |
| ------------ | ------------------------------------------------------------- | ------------------- |
| Build deps   | `pnpm --filter "@lunora/auth..." run build`                   | exit 0              |
| Auth tests   | `pnpm --filter "@lunora/auth" run test`                       | all pass            |
| Types / lint | `pnpm --filter "@lunora/auth" run lint:types` / `lint:eslint` | exit 0              |

## Scope

**In scope**:

- `packages/auth/__tests__/admin.behaviour.test.ts` (extend), or a sibling
  `admin.orgs.behaviour.test.ts` if the file would exceed ~600 lines (match
  the harness verbatim in that case)

**Out of scope**:

- `packages/auth/src/**` — this plan adds tests. A genuine bug found by a new
  test is a STOP-and-report, not an inline fix.
- The runtime routes (`packages/runtime/src/auth-admin-routes.ts`) and the
  studio UI.
- `plugins.behaviour.test.ts` (leave the plugin-level tests alone).

## Git workflow

- Branch: `advisor/123-auth-org-admin-tests`
- Suggested commit: `test(auth): behavioral coverage for the org/team admin surface`.

## Steps

### Step 1: Org-enabled harness

In the test file, add a second `describe` (or the sibling file) whose
`beforeEach` builds `createAuth` with the `organization` plugin enabled and a
database seeded with the org model keys. Confirm the model names by running
one `createOrganization` and inspecting `Object.keys(database)` /
better-auth's error message if a key is missing.

**Verify**: a smoke test — `createOrganization({ name, slug, ownerId })`
returns an org and `database["member"]` gains exactly one owner-role row.

### Step 2: Happy-path + negative tests per method group

Write tests (each with `expect.assertions`), covering at minimum:

1. **createOrganization** seeds the owner member with the owner role
   (assert both the `organization` row and the `member` row's `userId`/role).
2. **addMember** adds with the given role; adding to a nonexistent org id —
   assert the observed behavior explicitly (throws or creates an orphan row;
   whichever it is, pin it and flag orphan-creation in your report).
3. **updateMemberRole** changes exactly the addressed member's role; the
   other members' rows are byte-unchanged; array `role` input round-trips
   through `serializeRole`.
4. **removeMember** deletes exactly the addressed row (seed 2 members across
   2 orgs; remove one; assert the other 3 rows survive — the IDOR-shaped
   analog of the `unlinkAccount` test).
5. **inviteMember / cancelInvitation** — an invitation row is created with
   the resolved inviter (the owner, per the implementation at ~:756) and
   cancel removes/marks exactly it.
6. **deleteOrganization** cascade: seed an org with members + invitations
   (+ teams if enabled), delete it, assert all dependent rows are gone AND an
   unrelated org's rows survive (the cascade's where-clauses are the
   highest-risk code in the surface, `admin.ts:~711-738`).
7. **updateOrganization** null-echo synthesis: the method returns a row even
   when the adapter echoes `null` (mirror the `updateMemberRole` comment).
8. **listMembers / listInvitations / listOrganizations** return what was
   seeded, respecting any limit parameter.

Use the runtime-route parameter shapes (`{ organizationId, role, userId }`,
`{ memberId }`, …) exactly as typed at `admin.ts:258-322`.

**Verify** after each group: `pnpm --filter "@lunora/auth" run test` → green.

### Step 3: Team/role methods (if enabled in the plugin config)

If the harness's `organization()` plugin call enables teams (check
`plugins.behaviour.test.ts` for the option), cover `createTeam`,
`addTeamMember`, `removeTeamMember` (exact-row deletion, as in 4) and
`createOrgRole`. If teams are NOT enabled in the shipped plugin default,
enable them in this describe's plugin options only.

**Verify**: full suite green.

## Test plan

This plan IS the test plan — expect roughly 12–18 new `it` blocks. Model
structure, naming, and `expect.assertions` usage on the existing user-op
tests in the same file.

## Done criteria

- [ ] `pnpm --filter "@lunora/auth" run test` → all pass; ≥12 new org/team tests
- [ ] Every method listed in Step 2 items 1–8 has at least one test
- [ ] The removeMember and deleteOrganization tests assert _survivor_ rows,
      not just deleted ones
- [ ] `lint:types` + `lint:eslint` exit 0 for `@lunora/auth`
- [ ] No source files modified (`git status` shows only `__tests__`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The org methods no longer exist on `createAuthAdmin` (surface moved).
- The memory adapter cannot express the org models (better-auth version
  drift) — report the error rather than mocking around it.
- Any test reveals a real defect (e.g. deleteOrganization's cascade deletes
  another org's rows, addMember silently orphans) — report with the failing
  test; do NOT fix `src/`.
- You need to modify `createAuth`/plugin defaults beyond this describe's local
  options to make the harness work.

## Maintenance notes

- These tests pin the adapter-level contracts the Studio org UI relies on.
  When the runtime routes gain org-scoping context (e.g. an org-id check
  before `removeMember`), add the true cross-org IDOR test then.
- Reviewers: the interesting assertions are the survivor-row ones — a test
  that only checks the deleted row would pass even with an over-broad delete.
