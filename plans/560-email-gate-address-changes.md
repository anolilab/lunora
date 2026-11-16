# Plan 560 — Run the email-domain gate on address changes, not only on user creation

> **Executor instructions.** Follow this plan step by step. Run every `Verify:` command and
> confirm the expected result before moving on. Touch only the files listed under "In scope".
> If any STOP condition occurs, stop and report; do not improvise. Do not update
> `plans/README.md` (your reviewer maintains it).
>
> **Drift check (run first):**
> `git diff --stat 36c32cc1b..HEAD -- packages/auth/src/email-gate.ts packages/auth/__tests__/email-gate.test.ts packages/auth/docs/index.mdx packages/auth/README.md`
> Expected: no output. If any file changed, compare the excerpts in §1 with the live code;
> any mismatch is a STOP condition.

**Baseline:** `36c32cc1b` (2026-11-11)
**Status:** DONE (APPROVED on review 2026-11-11; branch `security/improve-560-email-gate-address-change`, commit `f868ccf9b`, not merged)
**Priority / Effort / Risk:** P2 / S / LOW. **Category:** security. **Depends on:** none.
**Finding:** audit 2026-11-11, row 38.

## 0. Headline finding

`withEmailGate` / `emailGateDatabaseHooks` (`@lunora/auth`) block disposable or denied email
domains, but only when a user row is **created**. A user who signed up with an allowed
address can then move the account to a blocked domain through any address-change path:
better-auth's `/change-email`, the email-OTP plugin's `/email-otp/change-email`, the admin
plugin's `/admin/update-user`, or Lunora's `AuthAdmin.updateUser`. That undoes the policy the
app configured.

## 1. Current state (audit)

`packages/auth/src/email-gate.ts` (150 lines):

- `:22-26`: types are derived from better-auth's options so an upstream rename fails to
  compile:

    ```ts
    type DatabaseHooks = NonNullable<BetterAuthOptions["databaseHooks"]>;
    type UserCreateBefore = NonNullable<NonNullable<NonNullable<DatabaseHooks["user"]>["create"]>["before"]>;
    ```

- `:63-90`: `buildBeforeHook(config)` reads `user.email`, passes an absent or empty one
  through, calls `assertEmailAllowed(email, { ...config, lists: { disposable: config.blockDisposable !== false || observed, free: observed } })`
  (where `observed = config.onClassify !== undefined`), maps a `LunoraError` to
  `new APIError(statusString(error.status), { code: error.code, message: error.message })`,
  and finally calls `config.onClassify?.(classification, user, context)`.
- `:106-110`:

    ```ts
    const emailGateDatabaseHooks = (config: EmailGateHookConfig = {}): DatabaseHooks => {
        return {
            user: { create: { before: buildBeforeHook(config) } },
        };
    };
    ```

- `:122-147`: `withEmailGate(options, config)` composes the gate **before** an existing
  `databaseHooks.user.create.before` (gate first, then theirs) and spreads every other existing
  hook through. It knows nothing about `user.update`.

How better-auth 1.7.16 (the installed version) changes an address. This was verified in
`node_modules/better-auth/dist`:

- `db/internal-adapter.mjs:634-657`: `updateUser(userId, data)` and
  `updateUserByEmail(email, data)` both call `updateWithHooks({ ...data, ...(data.email ? { email: data.email.toLowerCase() } : {}) }, …, "user", …)`.
- `db/with-hooks.mjs:44-61`: `updateWithHooks` calls every `hooks.user.update.before(data, context)`
  with **the patch only** (not the full row). A hook that throws aborts the write. The patch has
  an `email` key only when the address changes.
- `api/routes/update-user.mjs` (`/change-email`, around line 461) calls
  `internalAdapter.updateUser(userId, { email: newEmail })` when
  `user.changeEmail.updateEmailWithoutVerification` is on. Otherwise the change happens at
  `/verify-email` (`api/routes/email-verification.mjs:223,249`) through the same `updateUser`.
- `plugins/email-otp/routes.mjs:719` (`/email-otp/change-email`) and the admin plugin's
  `/admin/update-user` also go through `internalAdapter.updateUser`. So does
  `packages/auth/src/admin.ts:1388` (`AuthAdmin.updateUser`).

So one `user.update.before` hook covers every address-change path.

Docs that describe the gate as sign-up only:

- `packages/auth/docs/index.mdx:700-735` ("Disposable / free-email gating", "Wire it into
  better-auth's native `/sign-up/email` endpoint…").
- `packages/auth/README.md:97-117` (same section).

## 2. Existing seams (do not reinvent)

- `assertEmailAllowed` and `EmailClassification` from `./email-guard`. These are already
  imported; the classifier itself is unchanged.
- `statusString` and the `LunoraError` → `APIError` mapping already in `buildBeforeHook`.
  Extract them into one shared helper rather than copying.
- Unit test pattern: `packages/auth/__tests__/email-gate.test.ts` mocks `assertEmailAllowed`
  with `vi.hoisted` + `vi.mock` and calls the hooks directly. Its `getBefore`, `fakeUser` and
  composition tests are the models.
- Behaviour test pattern (real better-auth, in-memory adapter, no mocks):
  `packages/auth/__tests__/invite-only.behaviour.test.ts` (top ~70 lines: `createAuth({ baseURL, database: memoryAdapter(database), emailAndPassword, secret })`,
  `seedMemoryDatabase()`, `auth.api.signUpEmail(...)`, `await auth.$context`).

## 3. The behavioural contract to preserve

- Creation-time behaviour is unchanged: every existing test in `email-gate.test.ts` passes
  unchanged, including the `onClassify` tests.
- `withEmailGate` still puts the gate first and still preserves every existing hook
  (`create.before`, plus any `update.before` and `update.after` the caller set).
- An update patch without `email` (name, image, role, ban fields…) never calls the classifier.
- No public export or type changes. `emailGateDatabaseHooks` still returns `DatabaseHooks`, so
  `api-snapshots/auth.api.md` is unchanged and `api:check` is not needed.

## 4. Design decisions

1. **Gate `user.update.before` whenever the patch carries a non-empty string `email`.** That is
   the one seam every address-change path reaches (see §1). Rejected: matching endpoint paths in
   a `hooks.before`. It would miss `AuthAdmin.updateUser`, which has no endpoint.
2. **`onClassify` stays creation-only**, so it is not called on an address change. Its documented
   contract is "react to `free` vs `business` at signup (e.g. tag the account)", and its second
   argument is the new user record, which an update hook does not have. The update gate loads only
   the lists the policy needs: `lists: { disposable: config.blockDisposable !== false, free: false }`.
   Say this in the `onClassify` doc comment. Rejected: firing `onClassify` with the patch, which
   changes its argument shape for existing callers.
3. **Same error shape on update** as on create (`APIError` 400 with the Lunora `code`), via the
   shared helper.

## 5. Workstreams

Single workstream (S), in the steps below.

## 6. Platform parity

Not applicable: no `ctx.*` surface or binding. better-auth hook wiring only.

## 7. Phasing & ordering

| Phase | Work              | Gate                                                          |
| ----- | ----------------- | ------------------------------------------------------------- |
| 0     | install, build    | `pnpm install`; `pnpm --filter "@lunora/auth..." run build`   |
| 1     | tests first (red) | new update-hook tests and behaviour test FAIL                 |
| 2     | implement         | `email-gate.test.ts` and `email-gate.behaviour.test.ts` green |
| 3     | docs, gates       | `lint:types`, `lint:eslint`, full `@lunora/auth` tests green  |

## Commands you will need

Run every command from the worktree root you were given (prefix each shell call with
`cd <worktree> &&`).

| Purpose             | Command                                                                           | Expected on success      |
| ------------------- | --------------------------------------------------------------------------------- | ------------------------ |
| Install             | `pnpm install`                                                                    | exit 0 (several minutes) |
| Build auth + deps   | `pnpm --filter "@lunora/auth..." run build`                                       | exit 0                   |
| One test file       | `pnpm --filter "@lunora/auth" exec vitest run __tests__/<file>.test.ts`           | all pass                 |
| Package tests       | `pnpm --filter "@lunora/auth" run test`                                           | all pass                 |
| Types               | `pnpm --filter "@lunora/auth" run lint:types`                                     | exit 0                   |
| Format code         | `pnpm exec oxfmt <changed .ts files>`                                             | exit 0                   |
| Format docs         | `pnpm exec prettier --write packages/auth/docs/index.mdx packages/auth/README.md` | exit 0                   |
| Lint (after format) | `pnpm --filter "@lunora/auth" run lint:eslint`                                    | exit 0, 0 warnings       |

**Forbidden** (they crash the machine when several worktrees run them at once): `pnpm run build`,
`pnpm run build:packages`, `pnpm run test` at the repo root, `pnpm run test:workerd`,
`pnpm run api:check`, `pnpm run api:update`, any `pnpm -r …`. The workerd suite is not
needed: no SQL, storage or Durable Object code changes.

## Scope

**In scope** (the only files you may modify):

- `packages/auth/src/email-gate.ts`
- `packages/auth/__tests__/email-gate.test.ts`
- `packages/auth/__tests__/email-gate.behaviour.test.ts` (create)
- `packages/auth/docs/index.mdx` (the "Disposable / free-email gating" section only)
- `packages/auth/README.md` (the "Disposable / free-email gating" section only)

**Out of scope** (do not touch):

- `packages/auth/src/email-guard.ts`: the classifier is correct.
- `packages/auth/src/admin.ts`, `invite-only.ts`, `audit-hooks.ts`: other plans.
- `packages/advisor/**`: its lint message still describes the sign-up gate correctly.
- `api-snapshots/**`, `CHANGELOG.md`, `plans/**`.

## Git workflow

- You are on branch `security/improve-560-email-gate-address-change` in a dedicated worktree.
  Do not create or switch branches.
- Stage explicit paths only (`git add <paths>`; never `git add -A`, `git commit -a` or `git stash`).
- Message (header ≤ 100 chars, body lines ≤ 100 chars):

    ```
    security(auth): run the email gate on address changes

    withEmailGate and emailGateDatabaseHooks now also install user.update.before, so a change
    of address through any better-auth or admin path meets the same domain policy as sign-up.
    onClassify still fires at creation only.
    ```

    Add any attribution trailer your own environment requires, after a blank line.

- The pre-commit hook formats and lints staged files and builds their deps. If it fails, fix the
  reported problem in an in-scope file and commit again. Never use `--no-verify`. If it fails
  twice for a reason outside the in-scope files, STOP.
- Do not push. Do not open a PR.

## Steps

### Step 1: Install and build

`pnpm install`, then `pnpm --filter "@lunora/auth..." run build`.

**Verify:** both exit 0.

### Step 2: Unit tests first (in `email-gate.test.ts`)

Add the type alias next to the file's existing `UserCreateBefore` alias:
`type UserUpdateBefore = NonNullable<NonNullable<NonNullable<DatabaseHooks["user"]>["update"]>["before"]>;`
and a helper `getUpdateBefore(hooks)` shaped like `getBefore` (throws `"expected a user.update.before hook"`
when absent). Add `describe("emailGateDatabaseHooks — address changes", …)` with:

1. "rejects a change to a blocked domain with the same coded APIError": mock a rejection
   exactly like the existing "rejects a blocked domain with a coded APIError" test, call
   `getUpdateBefore(emailGateDatabaseHooks({}))({ email: "x@mailinator.com" } as never, null)`,
   and assert `APIError`, `{ status: "BAD_REQUEST", statusCode: 400 }` and
   `{ body: { code: "EMAIL_DOMAIN_BLOCKED" } }`.
2. "ignores a patch that does not change the address": call it with `{ name: "Ada" }`, then with
   `{ email: "" }`. Both resolve `undefined` and `assertEmailAllowed` is not called.
3. "never calls onClassify on an address change": resolve the mock with
   `businessClassification`, build with `{ onClassify: vi.fn<OnClassify>() }`, call with
   `{ email: "cto@acme-corp.example" }`, assert the classifier was called once and `onClassify`
   was not called. Also assert the classifier's second argument has
   `lists: { disposable: true, free: false }`.

Add to `describe("withEmailGate — composition ordering", …)`:

4. "gates an address change before an existing user.update.before, and keeps that hook": the same
   shape as "runs the gate before an existing user.create.before hook…", but with
   `{ databaseHooks: { user: { update: { before: existingUpdate } } } }`. Assert the order is
   `["gate", "existing"]`, and that the merged options still carry `user.create.before` (the gate).
5. "keeps an existing user.update.after untouched": pass
   `{ databaseHooks: { user: { update: { after: existingAfter } } } }` and assert
   `merged.databaseHooks?.user?.update?.after` is `existingAfter` (`toBe`).

**Verify (must be RED):** `pnpm --filter "@lunora/auth" exec vitest run __tests__/email-gate.test.ts`.
Tests 1, 3 and 4 fail (no update hook exists). Test 2 may also fail at `getUpdateBefore`. All
existing tests pass. Record the output.

### Step 3: Behaviour test against real better-auth (create the file)

Create `packages/auth/__tests__/email-gate.behaviour.test.ts`, modelled on the top of
`invite-only.behaviour.test.ts` (same imports of `memoryAdapter` and `createAuth`, a
`seedMemoryDatabase()` returning `{ account: [], session: [], user: [], verification: [] }`,
`SECRET = "x".repeat(32)`, and the same module-level `STRONG_PASSWORD` constant that file declares). Build:

```ts
auth = createAuth(
    withEmailGate(
        { baseURL: "http://localhost", database: memoryAdapter(database), emailAndPassword: { enabled: true }, secret: SECRET },
        { denyDomains: ["blocked-domain.com"] },
    ),
);
```

Write a file docblock: a few lines saying this pins the hook on better-auth's real update path,
which every address-change route uses (`internalAdapter.updateUser`), with no mocks.

Tests (each with `expect.assertions(n)`):

1. "refuses moving an account to a denied domain, and keeps the old address": sign up
   `ada@example.com` with `auth.api.signUpEmail({ body: { email, name: "Ada", password: STRONG_PASSWORD } })`.
   Read `const context = await auth.$context;` and the user id from `database["user"][0]`. Then
   `await expect(context.internalAdapter.updateUser(id, { email: "ada@blocked-domain.com" })).rejects.toMatchObject({ body: { code: "EMAIL_DOMAIN_BLOCKED" } });`
   and assert `database["user"][0].email` is still `"ada@example.com"`.
2. "lets an account move to an allowed address": same setup, update to
   `"ada@example.org"`, which resolves, and the stored email is `"ada@example.org"`.
3. "refuses signing up on the denied domain (unchanged creation behaviour)": `signUpEmail` with
   `"eve@blocked-domain.com"` rejects, and `database["user"]` is empty.

**Verify (must be RED):** `pnpm --filter "@lunora/auth" exec vitest run __tests__/email-gate.behaviour.test.ts`.
Test 1 FAILS (the update succeeds); tests 2 and 3 pass. If test 1 passes, STOP: the premise is
wrong. If test 3 fails, STOP: the fixture is wrong (for example the address fails the syntax
check). Report it.

### Step 4: Implement

In `packages/auth/src/email-gate.ts`:

1. Add `type UserUpdateBefore = NonNullable<NonNullable<NonNullable<DatabaseHooks["user"]>["update"]>["before"]>;`
   beside `UserCreateBefore`.
2. Extract the classifier call and error mapping into
   `const gateAddress = async (email: string, config: EmailGateHookConfig, lists: { disposable: boolean; free: boolean }): Promise<EmailClassification>`.
   It runs `assertEmailAllowed(email, { ...config, lists })` and rethrows a `LunoraError` as the
   `APIError`. `buildBeforeHook` keeps its current behaviour by calling it with
   `{ disposable: config.blockDisposable !== false || observed, free: observed }` and then
   calling `onClassify`.
3. Add `buildUpdateBeforeHook(config): UserUpdateBefore`. It reads `patch.email`, returns when that
   is not a non-empty string, and otherwise
   `await gateAddress(email, config, { disposable: config.blockDisposable !== false, free: false })`.
   Its doc comment says why: every address-change path in better-auth and `AuthAdmin.updateUser`
   writes through `internalAdapter.updateUser`, whose `update.before` receives only the patch,
   and `onClassify` is creation-only.
4. `emailGateDatabaseHooks` returns
   `{ user: { create: { before: buildBeforeHook(config) }, update: { before: buildUpdateBeforeHook(config) } } }`.
5. `withEmailGate` composes `update.before` exactly as it composes `create.before` (gate first,
   then the existing hook with the same `(patch, context)`, returning the existing hook's
   result), and spreads `options.databaseHooks?.user?.update` so `update.after` survives.
6. Update the module docblock, `EmailGateHookConfig.onClassify`'s comment ("Never fires on an
   address change") and the two function docblocks: the gate covers creation **and** address
   changes. Keep comments about why, not what. No `.js` import extensions; exports unchanged.

**Verify:** `pnpm --filter "@lunora/auth" exec vitest run __tests__/email-gate.test.ts __tests__/email-gate.behaviour.test.ts`
→ all pass.

### Step 5: Docs

- `packages/auth/docs/index.mdx`, the "Disposable / free-email gating" section: change "Wire it
  into better-auth's native `/sign-up/email` endpoint" to say the gate runs when a user is
  created **and** when an address changes (`/change-email`, the email-OTP change, admin
  updates). Add one sentence: `onClassify` fires only at creation.
- `packages/auth/README.md`, same section: the same two facts, briefly.
- Run Prettier on both files.

**Verify:** `grep -nE "address change|change-email" packages/auth/docs/index.mdx packages/auth/README.md`
prints at least one line per file.

### Step 6: Gates

oxfmt on the changed `.ts` files, then `lint:types`, `lint:eslint`, and
`pnpm --filter "@lunora/auth" run test`.

**Verify:** each exits 0.

### Step 7: Commit

Stage exactly the in-scope files and commit with the message above.

**Verify:** `git status --porcelain` is empty; `git diff --stat 36c32cc1b..HEAD` lists only
in-scope files.

## Test plan

- Unit: 5 new tests in `email-gate.test.ts` (Step 2), modelled on the file's existing rejection
  and composition tests.
- Behaviour: 3 tests in the new `email-gate.behaviour.test.ts` (Step 3), modelled on
  `invite-only.behaviour.test.ts`.
- Red-without-fix: Steps 2 and 3 run before Step 4 and must fail where stated.

## Done criteria (all must hold)

- [ ] `pnpm --filter "@lunora/auth" run test` exits 0, including the 8 new tests
- [ ] `pnpm --filter "@lunora/auth" run lint:types` exits 0
- [ ] `pnpm --filter "@lunora/auth" run lint:eslint` exits 0
- [ ] `grep -c "buildUpdateBeforeHook" packages/auth/src/email-gate.ts` prints 2 or more
- [ ] `git diff --stat 36c32cc1b..HEAD` lists only in-scope files

## 8. Risks & STOP conditions

- **STOP** if the Step 3 behaviour test 1 passes before the fix.
- **STOP** if any existing `@lunora/auth` test fails after the change. An update hook now runs on
  every user update; a failure means some other test updates an email to a blocked domain.
  Report the test; do not edit it.
- **STOP** if better-auth's types reject `update.before` returning `void` (an upstream signature
  change). Report the compiler error.
- **STOP** if a step's verification fails twice after a reasonable fix attempt.
- **Risk:** the update hook loads the disposable list on the first address change in an isolate.
  It is the same cost sign-up already pays, and the lists are cached.

## 9. Open questions

1. None for execution. Maintenance: a future better-auth path that writes `user.email` without
   `internalAdapter.updateUser` would bypass this gate. `email-gate.behaviour.test.ts` pins the
   current path; re-check it on a better-auth major bump.
