# Plan 562 — Invite-only admits a non-password account only when its address is verified

> **Executor instructions.** Follow this plan step by step. Run every `Verify:` command and
> confirm the expected result before moving on. Touch only the files listed under "In scope".
> If any STOP condition occurs, stop and report; do not improvise. Do not update
> `plans/README.md` (your reviewer maintains it).
>
> **Drift check (run first):**
> `git diff --stat 36c32cc1b..HEAD -- packages/auth/src/invite-only.ts packages/auth/__tests__/invite-only.behaviour.test.ts packages/auth/docs/plugins.mdx packages/auth/README.md`
> Expected: no output. Any change means comparing the excerpts in §1 with the live code;
> a mismatch is a STOP condition. After `pnpm install`, also run
> `grep -m1 '"version"' packages/auth/node_modules/better-auth/package.json`. The expected line
> is `"version": "1.7.16"`; anything else is a STOP condition.

**Baseline:** `36c32cc1b` (2026-11-11)
**Status:** DONE (APPROVED on review 2026-11-11; branch `security/improve-562-invite-only-verified-email`, commit `800e5304b`, not merged; SCIM refusal (§4.2) awaits an owner decision)
**Priority / Effort / Risk:** P1 / S / MED. **Category:** security. **Depends on:** none.
**Finding:** audit 2026-11-11, row 43 (confirmed against the installed better-auth 1.7.16; see §1).

## 0. Headline finding

`inviteOnly()` checks the invitation **token** only on `/sign-up/email`. Every other
account-creating path is admitted when an unspent invitation exists for the email address, on
the assumption that "an OAuth callback carries a provider-verified email". In better-auth 1.7.16
that assumption is false. An OAuth or SSO callback creates the user with whatever
`emailVerified` the provider reports, and several built-in providers always report `false`.
Anyone who can register that address at such a provider can therefore take an invited seat
without the invitation link.

## 1. Current state (audit)

`packages/auth/src/invite-only.ts` (769 lines):

- `:44-62` (module docblock) and `:419-433` (comment on `hooks.before`): "The token is checked on
  `/sign-up/email` and nowhere else… an OAuth callback carries a provider-verified email, and
  magic-link and email-OTP only fire for whoever is holding the mailbox."
- `:434-485`: `hooks.before` with `matcher: (context) => context.path === "/sign-up/email"`,
  which requires and checks the token.
- `:494-510`: the universal gate, installed as `databaseHooks.user.create.before`:

    ```ts
    const before: UserCreateBefore = async (user) => {
        if (anonymousInstalled && isAnonymousUser(user)) {
            return;
        }

        const email = emailOf(user);

        if (email !== undefined && (await hasUsableInvitation(adapter, email))) {
            return;
        }

        if (await inBootstrapWindow(adapter)) {
            return;
        }

        throw new APIError("BAD_REQUEST", ERROR_CODES.SIGN_UP_INVITE_REQUIRED);
    };
    ```

    It never reads `user.emailVerified`, and it ignores its second argument (the endpoint
    context).

- `:517-527`: `create.after` marks the invitation spent (`acceptedAt`) for any created user.

Verified in the installed better-auth 1.7.16 (`node_modules/better-auth/dist`,
`node_modules/@better-auth/*/dist`):

- `oauth2/link-account.mjs` (`handleOAuthUserInfo`, ~:296-316): a new OAuth user is created with
  `emailVerified: userInfo.emailVerified` from the provider. The provider-level
  `requireEmailVerification` check runs **after** `createUser` (~:349-356). By then the user row
  exists and `create.after` has already spent the invitation.
- `@better-auth/core/dist/social-providers/*.mjs`: `atlassian`, `cloudflare`, `figma`, `kick`,
  `line`, `linear`, `naver`, `notion` and `railway` hard-code `emailVerified: false`.
  `github`, `gitlab`, `facebook`, `linkedin` and others report `false` for an address the
  provider has not verified.
- `@better-auth/sso` (`dist/index.mjs` ~:3007, :3947, :3958, :3971): OIDC and SAML users get
  `emailVerified: false` unless the provider config sets `trustEmailVerified`.
- `@better-auth/scim` (`dist/index.mjs` ~:7003): SCIM creates users with no `emailVerified`.
- `plugins/magic-link/index.mjs` ~:179 and `plugins/email-otp/routes.mjs` ~:400 create users
  with `emailVerified: true`. `/sign-up/email` (`api/routes/sign-up.mjs` ~:217) creates with
  `emailVerified: false`, and the token check in `hooks.before` covers it. `/admin/create-user`
  (`plugins/admin/routes.mjs` ~:196) is admin-authorized.
- `db/with-hooks.mjs:7-17`: `createWithHooks` calls `create.before(data, context)`, where
  `context = tryGetCurrentAuthEndpointContext()`. That is the endpoint context, with
  `context.path` set to the endpoint's **template** path (`dist/api/dispatch.mjs` ~:204,
  `path: endpoint.path`), or `null` when no endpoint is running (for example Lunora's
  `AuthAdmin.createUser`, `packages/auth/src/admin.ts:1047-1080`, which runs on `auth.$context`).
  The provisioning `source` (`{ method: "oauth" }`) does **not** reach database hooks; only
  `validateUserInfo` receives it.

Tests: `packages/auth/__tests__/invite-only.behaviour.test.ts` runs the real better-auth on
`memoryAdapter`. The test "gates an OAuth callback minting a new account" (~:311-331) calls
`context.internalAdapter.createOAuthUser(...)` **outside** any endpoint (context `null`) with
`emailVerified: true`. It is not a faithful model of a callback, which runs inside an
endpoint.

Docs that repeat the false assumption: `packages/auth/docs/plugins.mdx:356-362`
("It gates **every** path that mints a user…") and `packages/auth/README.md` ("### Invite-only
sign-up", ~line 122).

## 2. Existing seams (do not reinvent)

- `hasUsableInvitation`, `inBootstrapWindow`, `isAnonymousUser`, `emailOf` and `ERROR_CODES`,
  all in `invite-only.ts`.
- `runWithEndpointContext` from `@better-auth/core/context` (already a dependency: the file
  imports `@better-auth/core/utils/error-codes`). Tests use it to run a create inside an
  endpoint context, the way a real callback does.

## 3. The behavioural contract to preserve

- Password sign-up of an invited address with the right token still works (it creates an
  unverified user; the token is the proof). All existing tests pass unchanged.
- `AuthAdmin.createUser` (no endpoint context) still admits an invited address without
  verification ("gates the trusted admin plane too").
- Anonymous sign-in still bypasses the gate when `anonymous()` is installed.
- The `allowFirstUser` bootstrap is unchanged.
- The rejection is the same `SIGN_UP_INVITE_REQUIRED` 400 whether there is no invitation or the
  address is unverified. That gives no new oracle.

## 4. Design decisions

1. **Admit an invited address only through a path that proved the address.** In
   `create.before`, an existing usable invitation admits the user only when one of these holds:
    - `user.emailVerified === true` (OAuth/SSO with a verified claim, magic link, email OTP);
    - `context?.path === "/sign-up/email"` (the token was checked in `hooks.before`);
    - `context?.path === "/admin/create-user"` (better-auth admin plugin, admin-authorized);
    - `context` is `null` or `undefined` (no endpoint is running: server-side code such as
      `AuthAdmin.createUser`, which is admin-token gated).

    Otherwise the code falls through to the bootstrap check and then refuses.
    Rejected alternative: reading the provisioning `source` (`method: "oauth"`). better-auth
    1.7.16 does not pass it to database hooks.

2. **SCIM is not exempt.** It creates users with no verified address, and SCIM tokens are issued
   per organization, not by the app operator. Under `inviteOnly()`, SCIM provisioning of an
   invited address is refused. This is documented. Rejected: exempting `/scim/v2/*`, which
   would let an organization admin claim a seat invited for someone else. Owner may revisit
   (§9).
3. **Uniform refusal**: the same `SIGN_UP_INVITE_REQUIRED` error, no new code, so the response
   does not reveal that the address is on the list.
4. **Docs state the consequence**: an OAuth or SSO provider that does not report a verified
   address cannot accept an invitation; set `trustEmailVerified` on an SSO provider you trust,
   or invite users to sign up with a password or magic link.

## 5. Workstreams

Single workstream (S), in the steps below.

## 6. Platform parity

Not applicable: no `ctx.*` surface or binding.

## 7. Phasing & ordering

| Phase | Work                          | Gate                                                            |
| ----- | ----------------------------- | --------------------------------------------------------------- |
| 0     | install, version check, build | better-auth 1.7.16; `pnpm --filter "@lunora/auth..." run build` |
| 1     | tests first (red)             | unverified-OAuth test FAILS                                     |
| 2     | gate                          | `invite-only.behaviour.test.ts` green                           |
| 3     | docs, gates                   | lint, types, package tests green                                |

## Commands you will need

Run every command from the worktree root you were given (prefix each shell call with
`cd <worktree> &&`).

| Purpose             | Command                                                                                | Expected on success      |
| ------------------- | -------------------------------------------------------------------------------------- | ------------------------ |
| Install             | `pnpm install`                                                                         | exit 0 (several minutes) |
| Build auth + deps   | `pnpm --filter "@lunora/auth..." run build`                                            | exit 0                   |
| One test file       | `pnpm --filter "@lunora/auth" exec vitest run __tests__/invite-only.behaviour.test.ts` | all pass                 |
| Package tests       | `pnpm --filter "@lunora/auth" run test`                                                | all pass                 |
| Types               | `pnpm --filter "@lunora/auth" run lint:types`                                          | exit 0                   |
| Format code         | `pnpm exec oxfmt <changed .ts files>`                                                  | exit 0                   |
| Format docs         | `pnpm exec prettier --write packages/auth/docs/plugins.mdx packages/auth/README.md`    | exit 0                   |
| Lint (after format) | `pnpm --filter "@lunora/auth" run lint:eslint`                                         | exit 0, 0 warnings       |

**Forbidden** (they crash the machine when several worktrees run them at once): `pnpm run build`,
`pnpm run build:packages`, `pnpm run test` at the repo root, `pnpm run test:workerd`,
`pnpm run api:check`, `pnpm run api:update`, any `pnpm -r …`. No public export changes
(`api:check` is not needed). The workerd suite is not needed: the invitation reads and writes
are unchanged.

## Scope

**In scope** (the only files you may modify):

- `packages/auth/src/invite-only.ts`
- `packages/auth/__tests__/invite-only.behaviour.test.ts`
- `packages/auth/docs/plugins.mdx` (the "Invite-only sign-up" section only)
- `packages/auth/README.md` (the "Invite-only sign-up" section only)

**Out of scope** (do not touch):

- `packages/auth/src/admin.ts`: the comment there about provenance reaching hooks is
  imprecise but harmless. Do not edit it here.
- `packages/auth/src/email-gate.ts`, `audit-hooks.ts`: other plans.
- The `hooks.before` token check on `/sign-up/email`: correct as is.
- `CHANGELOG.md`, `plans/**`, `api-snapshots/**`.

## Git workflow

- You are on branch `security/improve-562-invite-only-verified-email` in a dedicated worktree.
  Do not create or switch branches.
- Stage explicit paths only (`git add <paths>`; never `git add -A`, `git commit -a` or `git stash`).
- Message (header ≤ 100 chars, body lines ≤ 100 chars):

    ```
    security(auth): admit invited oauth and sso accounts only with a verified email

    inviteOnly() now admits an invited address through a path other than password sign-up only
    when the new user's email is verified, or when no endpoint is running (trusted server
    code) or the admin plugin creates it.

    BREAKING CHANGE: an OAuth or SSO provider that does not report a verified address, and SCIM
    provisioning, can no longer accept an invitation.
    ```

    Add any attribution trailer your own environment requires, after a blank line.

- The pre-commit hook formats and lints staged files and builds their deps. If it fails, fix the
  reported problem in an in-scope file and commit again. Never use `--no-verify`. If it fails
  twice for a reason outside the in-scope files, STOP.
- Do not push. Do not open a PR.

## Steps

### Step 1: Install, version check, build

`pnpm install`; `grep -m1 '"version"' packages/auth/node_modules/better-auth/package.json`;
`pnpm --filter "@lunora/auth..." run build`.

**Verify:** exit 0; version `1.7.16`.

### Step 2: Tests first

In `packages/auth/__tests__/invite-only.behaviour.test.ts`:

- Add `import { runWithEndpointContext } from "@better-auth/core/context";` with the other
  imports.
- Add a helper inside the top-level `describe`:

    ```ts
    /** Run `create` the way a real route does: inside better-auth's endpoint context, whose `path` the gate reads. */
    const insideEndpoint = async <T>(path: string, create: () => Promise<T>): Promise<T> =>
        runWithEndpointContext({ context: await auth.$context, path } as unknown as Parameters<typeof runWithEndpointContext>[0], create);
    ```

- Add `describe("non-password sign-up of an invited address", …)` with:
    1. "refuses an OAuth account whose provider did not verify the address": invite
       `ada@example.com` with `createSignUpInvitation`. Then
       `await expect(insideEndpoint("/callback/:id", async () => context.internalAdapter.createOAuthUser({ email: "ada@example.com", emailVerified: false, name: "Ada" }, { accountId: "li-1", providerId: "linear" }))).rejects.toThrow(/invite-only/);`.
       Assert `database["user"]` has length 0 and `invitationRow("ada@example.com")?.["acceptedAt"]`
       is falsy (the seat is not spent).
    2. "refuses an SSO account without a trusted verified claim": the same with path
       `"/sso/callback/:providerId"` and `providerId: "okta"`, which rejects.
    3. "admits an OAuth account whose provider verified the address": the same as test 1 with
       `emailVerified: true`, which resolves, and the invitation is marked spent.
    4. "admits an invited address created by the admin plugin's endpoint": inside path
       `"/admin/create-user"`, `context.internalAdapter.createUser({ email: "ada@example.com", name: "Ada" })`
       resolves.
- Before the test that calls `createOAuthUser` outside an endpoint ("gates an OAuth callback
  minting a new account"), add one comment line: it runs without an endpoint context, which the
  gate treats as trusted server code, so the real-callback cases live in the new `describe`
  above. Do not change its assertions.

**Verify (must be RED):**
`pnpm --filter "@lunora/auth" exec vitest run __tests__/invite-only.behaviour.test.ts`.
Tests 1 and 2 FAIL (the create resolves). Tests 3 and 4 and every existing test pass. If test 1
passes, STOP: the premise is wrong. If test 3 or 4 fails, STOP: the fixture is wrong. Report it.

### Step 3: Implement the gate

In `packages/auth/src/invite-only.ts`:

1. Change the `before` hook to take `(user, context)` and implement §4.1. Shape:

    ```ts
    const email = emailOf(user);

    if (email !== undefined && admitsUnverified(context, user) && (await hasUsableInvitation(adapter, email))) {
        return;
    }
    ```

    where `admitsUnverified` is a small module-level function that returns
    `user["emailVerified"] === true || context === null || context === undefined || TRUSTED_CREATE_PATHS.has(context.path)`,
    with `const TRUSTED_CREATE_PATHS = new Set(["/sign-up/email", "/admin/create-user"]);`.
    Name it for what it decides (e.g. `provesAddress`). Type `context` from the hook signature
    (`Parameters<UserCreateBefore>[1]`) rather than redeclaring better-auth types. Keep the
    anonymous early return, the bootstrap fallback and the final throw exactly as they are.

2. Give `TRUSTED_CREATE_PATHS` and the function a comment saying why each entry is trusted (the
   token is checked on `/sign-up/email`; `/admin/create-user` is admin-authorized; no endpoint
   means server code) and that better-auth creates OAuth/SSO users with the provider's own
   `emailVerified`, which several providers always report `false`.
3. Rewrite the module docblock's "Security — two checks" section (`:44-62`) and the
   `hooks.before` comment (`:419-433`). Remove the claim that an OAuth callback carries a
   provider-verified email. State the rule from §4.1, and that unverified OAuth/SSO and SCIM
   cannot accept an invitation. Keep the rest of the docblock.

**Verify:** `pnpm --filter "@lunora/auth" exec vitest run __tests__/invite-only.behaviour.test.ts`
→ all pass, including the 4 new tests.

### Step 4: Docs

- `packages/auth/docs/plugins.mdx`, "Invite-only sign-up": after the paragraph that lists the
  gated paths, add a short paragraph. Password sign-up needs the invitation token. Any other
  path accepts an invitation only when the new account's email is verified: magic link and email
  OTP are; an OAuth or SSO account is only when the provider reports it verified. Several
  built-in providers never do (name two, e.g. Linear, Notion). SSO reports unverified unless the
  provider sets `trustEmailVerified`. SCIM provisioning cannot accept an invitation.
- `packages/auth/README.md`, "### Invite-only sign-up": one or two sentences with the same rule.
- Run Prettier on both files.

**Verify:** `grep -n "trustEmailVerified" packages/auth/docs/plugins.mdx` prints at least one line.

### Step 5: Gates

oxfmt on the changed `.ts` files, then `lint:types`, `lint:eslint`,
`pnpm --filter "@lunora/auth" run test`.

**Verify:** each exits 0.

### Step 6: Commit

Stage exactly the in-scope files and commit with the message above.

**Verify:** `git status --porcelain` is empty; `git diff --stat 36c32cc1b..HEAD` lists only
in-scope files.

## Test plan

- 4 new tests in `invite-only.behaviour.test.ts` (Step 2), modelled on that file's existing
  "gates an OAuth callback minting a new account" and "gates the trusted admin plane too", but
  run inside `runWithEndpointContext` so the gate sees a real route path.
- Red-without-fix: Step 2 runs before Step 3, and tests 1 and 2 must fail.
- Regression: every existing invite-only test, plus the whole `@lunora/auth` suite.

## Done criteria (all must hold)

- [ ] `pnpm --filter "@lunora/auth" run test` exits 0, including the 4 new tests
- [ ] `pnpm --filter "@lunora/auth" run lint:types` and `run lint:eslint` exit 0
- [ ] `grep -n "provider-verified email" packages/auth/src/invite-only.ts` prints nothing
- [ ] `grep -n "trustEmailVerified" packages/auth/docs/plugins.mdx` prints at least one line
- [ ] `git diff --stat 36c32cc1b..HEAD` lists only in-scope files

## 8. Risks & STOP conditions

- **STOP** if better-auth is not 1.7.16.
- **STOP** if Step 2 test 1 passes before the fix.
- **STOP** if an existing `@lunora/auth` test fails after the change. Report which one, and do not
  edit it: it may be a legitimate path this plan missed.
- **STOP** if `runWithEndpointContext` is not exported from `@better-auth/core/context` in the
  installed version.
- **STOP** if a step's verification fails twice after a reasonable fix attempt.
- **Risk (MED):** apps using `inviteOnly()` with a provider that reports unverified addresses lose
  that sign-up path for invitees. Intended; documented in the commit body and docs.

## 9. Open questions

1. Owner: should SCIM provisioning be allowed to claim an invitation (§4.2)? Today it is refused.
2. Maintenance: a new better-auth account-creation endpoint that creates users unverified, and is
   trusted, would need adding to `TRUSTED_CREATE_PATHS`. A new provider path is fail-closed by
   default.
