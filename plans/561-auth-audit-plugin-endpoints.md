# Plan 561 — Record plugin sign-ins, admin actions and account changes in the auth audit trail

> **Executor instructions.** Follow this plan step by step. Run every `Verify:` command and
> confirm the expected result before moving on. Touch only the files listed under "In scope".
> If any STOP condition occurs, stop and report; do not improvise. Do not update
> `plans/README.md` (your reviewer maintains it).
>
> **Drift check (run first):**
> `git diff --stat 36c32cc1b..HEAD -- packages/auth/src/audit-hooks.ts packages/auth/src/audit.ts packages/auth/src/plugins.ts packages/auth/src/plugins-enterprise.ts packages/auth/__tests__/audit.test.ts api-snapshots/auth.api.md`
> Expected: no output. Any change means comparing the excerpts in §1 with the live code;
> a mismatch is a STOP condition. Also run `grep -m1 '"version"' packages/auth/node_modules/better-auth/package.json`
> after `pnpm install`; expected `"version": "1.7.16"`. A different version is a STOP
> condition, because the endpoint table in §4 was taken from 1.7.16.

**Baseline:** `36c32cc1b` (2026-11-11)
**Status:** DONE (APPROVED on review 2026-11-11 after one REVISE round (docblock placement); branch `security/improve-561-auth-audit-coverage`, commit `cb359bf05`, not merged; reviewer ran `build:packages` + `api:check` (pass))
**Priority / Effort / Risk:** P2 / M / LOW. **Category:** security. **Depends on:** none.
**Finding:** audit 2026-11-11, row 42.

## 0. Headline finding

`authAuditHook` (`@lunora/auth`) decides what to record from a fixed list of endpoint paths.
Anything outside the list writes no row. `@lunora/auth/plugins` re-exports plugins whose
session-issuing and account-changing endpoints match none of the list:

- passkey and SIWE sign-in, one-time-token sign-in, the device-code token, One Tap, and the
  shared SSO callback;
- every admin-plugin action: impersonation, ban, role change, password set, user
  create/update/remove, and session revoke;
- account deletion and email change;
- API-key and one-time-token issuance, passkey registration and removal, and backup-code
  regeneration.

The hook's own docblock calls a trail that sees a session open but not close "worse than
either gap". This finding is the larger version of that gap.

## 1. Current state (audit)

`packages/auth/src/audit-hooks.ts` (438 lines):

- `:128-191`: `eventForPath(path)` lowercases the path and matches with
  `ends(suffix)` (equal or suffix) and `normalized.includes(…)`, in this order: sign-up,
  sign-in-initiated (`/sign-in/social`, `/sign-in/magic-link`, `/sign-in/sso`), sign-in
  (`includes("/sign-in/")`, `includes("/callback/")`, `includes("/saml2/sp/acs/")`,
  `ends("/magic-link/verify")`, `includes("/two-factor/verify-")`), sign-out,
  password-change, password-reset, email-verification, mfa-enable, mfa-disable,
  token-refresh (`ends("/refresh-token") || ends("/token")`), session-revoke, account-link,
  account-unlink. Anything else returns `undefined`.
- `:313-337`: `buildAuditEntry(context, …)` builds `{ actorId?, actorEmail?, event, outcome, ts, ip?, targetEmail?, userAgent?, detail: { path } }`.
- `:378-411`: `authAuditHook` appends the entry. It **must return `undefined`** (see the
  comment there). Do not change that.

`packages/auth/src/audit.ts:39-57`: `type AuthAuditEvent` is an alphabetical string-literal
union ending in `| (string & {})`. It is printed in `api-snapshots/auth.api.md:331` as one line:

```ts
type AuthAuditEvent =
    | "account-link"
    | "account-unlink"
    | "email-verification"
    | "mfa-disable"
    | "mfa-enable"
    | "password-change"
    | "password-reset"
    | "session-revoke"
    | "sign-in"
    | "sign-in-initiated"
    | "sign-out"
    | "sign-up"
    | "token-refresh"
    | (string & {});
```

**What `path` is at runtime.** This was verified in the installed better-auth 1.7.16,
`dist/api/dispatch.mjs` around line 204: the hook context gets `path: endpoint.path`. That is
the endpoint's **template** path, without the app's `basePath`, for example `/callback/:id` or
`/sso/callback/:providerId`. Existing tests also pass basePath-prefixed concrete paths
(`/api/auth/callback/github`). The classifier must handle both, which suffix matching does.

**Endpoint paths of the installed plugins** were enumerated from 1.7.16 by constructing each
plugin and reading `plugin.endpoints[*].path`. Core paths came from `betterAuth({ emailAndPassword: { enabled: true }, … }).api`.
These are the inputs to the table in §4. Gaps they reveal in today's classifier:

- No branch at all: `/passkey/verify-authentication`, `/siwe/verify`, `/one-time-token/verify`,
  every `/admin/*`, `/delete-user`, `/delete-user/callback`, `/delete-anonymous-user`,
  `/change-email`, `/email-otp/change-email`, `/forget-password/email-otp`,
  `/phone-number/verify`, `/multi-session/set-active`, `/multi-session/revoke`,
  `/device/approve`, `/device/deny`, `/api-key/create|update|delete`,
  `/one-time-token/generate`, `/passkey/verify-registration`, `/passkey/delete-passkey`,
  `/two-factor/generate-backup-codes`.
- Missed by `includes("/callback/")` because there is no trailing segment: `/one-tap/callback`
  and `/sso/callback` (the shared SSO callback). Both issue sessions.
- Misclassified: `/device/token` issues a session for the device (`createSession`, verified in
  `plugins/device-authorization/routes.mjs` around line 456) but matches `ends("/token")` and
  is recorded as `token-refresh`.

Re-export sources: `packages/auth/src/plugins.ts` (passkey `:120`, `oneTap` `:138`,
`admin` `:142`, `anonymous` `:143`, `deviceAuthorization` `:146`, `emailOTP` `:147`,
`magicLink` `:151`, `multiSession` `:152`, `oneTimeToken` `:154`, `phoneNumber` `:156`,
`siwe` `:157`, `twoFactor` `:158`, `username` `:159`, `apiKey` `:96`) and
`packages/auth/src/plugins-enterprise.ts:74` (`sso`, a wrapper taking `options?`).

## 2. Existing seams (do not reinvent)

- `eventForPath` and `buildAuditEntry` stay the only classifier and builder. Extend them.
- Test file and style: `packages/auth/__tests__/audit.test.ts`,
  `describe("buildAuditEntry — classification & extraction", …)` (from line 338). It calls
  `buildAuditEntry({ path: … })?.event` and uses the in-memory `node:sqlite` `executorFor(database)`
  at the top of the file for persisted rows.

## 3. The behavioural contract to preserve

- Every existing assertion in `audit.test.ts` and `audit-hooks.behaviour.test.ts` still passes,
  with one intended change: `/device/token` moves from `token-refresh` to `sign-in`. (No
  existing test asserts `/device/token`. If one does, STOP.)
- `authAuditHook` still returns `undefined`.
- `targetEmail` is still only set for `sign-in` / `sign-in-initiated`.
- `AuthAuditEvent` stays an open union (`| (string & {})`), so adding names is not a type
  break for consumers. SIEM rules that enumerate event names must add the new ones; the commit
  body says so.

## 4. Design decisions

1. **One exact-suffix table, checked first.** Add a module-level
   `const SUFFIX_EVENTS: ReadonlyArray<readonly [suffix: string, event: AuthAuditEvent]>` and,
   at the top of `eventForPath`, return the event of the first entry where `ends(suffix)`
   holds. It runs before the existing branches, so `/device/token` wins over `ends("/token")`.
   Exact suffixes (never `includes("/admin/")`) keep an app `basePath` from changing the
   result. Rejected: more `includes(...)` branches. They are order-sensitive and are how
   `/device/token` went wrong.
2. **Admin actions get `admin-*` event names**, so a reader can tell an operator acting on
   someone else from a user acting on themselves. For every event that starts with `admin-`,
   `buildAuditEntry` adds `detail.targetUserId` when `context.body.userId` is a non-empty
   string. Otherwise an impersonation row would not say who was impersonated. Copy only
   `userId`; never copy other body fields (`set-user-password` carries the new password).
3. **New event names** (add all to `AuthAuditEvent`, in alphabetical order):
   `admin-impersonate-start`, `admin-impersonate-stop`, `admin-password-set`,
   `admin-role-change`, `admin-session-revoke`, `admin-user-ban`, `admin-user-create`,
   `admin-user-remove`, `admin-user-unban`, `admin-user-update`, `api-key-create`,
   `api-key-delete`, `api-key-update`, `device-approve`, `device-deny`, `email-change`,
   `mfa-backup-codes-regenerate`, `one-time-token-create`, `passkey-add`, `passkey-remove`,
   `phone-verification`, `session-switch`, `user-delete`.
4. **`SUFFIX_EVENTS` content (exactly these entries):**

    | Suffix                              | Event                         |
    | ----------------------------------- | ----------------------------- |
    | `/admin/impersonate-user`           | `admin-impersonate-start`     |
    | `/admin/stop-impersonating`         | `admin-impersonate-stop`      |
    | `/admin/set-role`                   | `admin-role-change`           |
    | `/admin/revoke-user-session`        | `admin-session-revoke`        |
    | `/admin/revoke-user-sessions`       | `admin-session-revoke`        |
    | `/admin/ban-user`                   | `admin-user-ban`              |
    | `/admin/unban-user`                 | `admin-user-unban`            |
    | `/admin/create-user`                | `admin-user-create`           |
    | `/admin/update-user`                | `admin-user-update`           |
    | `/admin/remove-user`                | `admin-user-remove`           |
    | `/api-key/create`                   | `api-key-create`              |
    | `/api-key/update`                   | `api-key-update`              |
    | `/api-key/delete`                   | `api-key-delete`              |
    | `/device/approve`                   | `device-approve`              |
    | `/device/deny`                      | `device-deny`                 |
    | `/device/token`                     | `sign-in`                     |
    | `/change-email`                     | `email-change`                |
    | `/delete-user`                      | `user-delete`                 |
    | `/delete-user/callback`             | `user-delete`                 |
    | `/delete-anonymous-user`            | `user-delete`                 |
    | `/forget-password/email-otp`        | `password-reset`              |
    | `/two-factor/generate-backup-codes` | `mfa-backup-codes-regenerate` |
    | `/one-time-token/generate`          | `one-time-token-create`       |
    | `/one-time-token/verify`            | `sign-in`                     |
    | `/one-tap/callback`                 | `sign-in`                     |
    | `/passkey/verify-authentication`    | `sign-in`                     |
    | `/passkey/verify-registration`      | `passkey-add`                 |
    | `/passkey/delete-passkey`           | `passkey-remove`              |
    | `/phone-number/verify`              | `phone-verification`          |
    | `/siwe/verify`                      | `sign-in`                     |
    | `/sso/callback`                     | `sign-in`                     |
    | `/multi-session/set-active`         | `session-switch`              |
    | `/multi-session/revoke`             | `session-revoke`              |

    One more row belongs in the table right after `/admin/stop-impersonating`: suffix `/admin/set-user-password`, event `admin-password-set`. <!-- secret-scanner:allow -->

    `/change-email` also catches `/email-otp/change-email`, the email-OTP change. That is intended.

5. **Every enumerated path is classified on purpose.** The new test (Step 2) holds an explicit
   `EXPECTED` map from every core and plugin path to its event **or `undefined`**, and asserts
   that the enumerated set and the map's keys are equal. A better-auth upgrade that adds an
   endpoint then fails the test until someone decides whether it is audited. The `undefined`
   entries are reads, dispatches (OTP/nonce/verification-email sends) and configuration.
6. **Deferred, named:** the `organization`, `oauthProvider`, `oauthDeviceAuthorization`,
   `scim`, `jwt`, `bearer`, `customSession`, `oAuthProxy`, `mcp`, `cimd` plugins and the SSO
   provider-management endpoints (`/sso/register`, `/sso/update-provider`,
   `/sso/delete-provider`). They manage tenants, clients and IdP configuration rather than one
   user's session or credentials, and each needs its own event vocabulary. They are not in the
   enumerated set, and the SSO management paths are pinned as `undefined` with a comment
   saying "deferred". Follow-up for the owner (§9).

## 5. Workstreams

Single workstream (M), in the steps below.

## 6. Platform parity

Not applicable: no `ctx.*` surface or binding. better-auth hook only.

## 7. Phasing & ordering

| Phase | Work                                    | Gate                                                            |
| ----- | --------------------------------------- | --------------------------------------------------------------- |
| 0     | install, build, version check           | better-auth 1.7.16; `pnpm --filter "@lunora/auth..." run build` |
| 1     | tests first (red)                       | completeness test and new classification tests FAIL             |
| 2     | classifier, event union, `targetUserId` | `audit.test.ts` green                                           |
| 3     | snapshot hand-edit, gates               | lint, types, package tests green                                |

## Commands you will need

Run every command from the worktree root you were given (prefix each shell call with
`cd <worktree> &&`).

| Purpose             | Command                                                                 | Expected on success      |
| ------------------- | ----------------------------------------------------------------------- | ------------------------ |
| Install             | `pnpm install`                                                          | exit 0 (several minutes) |
| Build auth + deps   | `pnpm --filter "@lunora/auth..." run build`                             | exit 0                   |
| One test file       | `pnpm --filter "@lunora/auth" exec vitest run __tests__/<file>.test.ts` | all pass                 |
| Package tests       | `pnpm --filter "@lunora/auth" run test`                                 | all pass                 |
| Types               | `pnpm --filter "@lunora/auth" run lint:types`                           | exit 0                   |
| Format              | `pnpm exec oxfmt <changed .ts files>`                                   | exit 0                   |
| Lint (after format) | `pnpm --filter "@lunora/auth" run lint:eslint`                          | exit 0, 0 warnings       |

**Forbidden** (they crash the machine when several worktrees run them at once): `pnpm run build`,
`pnpm run build:packages`, `pnpm run test` at the repo root, `pnpm run test:workerd`,
`pnpm run api:check`, `pnpm run api:update`, any `pnpm -r …`. Your reviewer runs `api:check`.
You hand-edit the snapshot in Step 5. The workerd suite is not needed: the audit table's SQL
is unchanged.

## Scope

**In scope** (the only files you may modify):

- `packages/auth/src/audit-hooks.ts`
- `packages/auth/src/audit.ts` (the `AuthAuditEvent` union only)
- `packages/auth/__tests__/audit.test.ts`
- `packages/auth/__tests__/audit-endpoint-coverage.test.ts` (create)
- `api-snapshots/auth.api.md` (the `AuthAuditEvent` line only)

**Out of scope** (do not touch):

- `packages/auth/src/plugins.ts`, `plugins-enterprise.ts`: read-only inputs to the test.
- The audit table schema, `appendAuthAuditEntry`, the redaction rules.
- `packages/studio/**`: it renders event strings generically.
- `packages/auth/src/admin.ts` (Lunora's own admin plane has its own audit log).
- `CHANGELOG.md`, `plans/**`.

## Git workflow

- You are on branch `security/improve-561-auth-audit-coverage` in a dedicated worktree. Do not
  create or switch branches.
- Stage explicit paths only (`git add <paths>`; never `git add -A`, `git commit -a` or `git stash`).
- Message (header ≤ 100 chars, body lines ≤ 100 chars):

    ```
    security(auth): audit plugin sign-ins, admin actions and account changes

    The audit hook now records passkey, SIWE, one-time-token, One Tap, device and shared SSO
    sign-ins, every admin-plugin action (with the subject's user id), account deletion, email
    change, and API-key, passkey and backup-code changes. /device/token is now sign-in, not
    token-refresh. A test pins a classification for every endpoint the re-exported plugins
    serve.

    BREAKING CHANGE: new AuthAuditEvent names; /device/token is recorded as sign-in. SIEM
    rules that enumerate event names should add the new ones.
    ```

    Add any attribution trailer your own environment requires, after a blank line.

- The pre-commit hook formats and lints staged files and builds their deps. If it fails, fix the
  reported problem in an in-scope file and commit again. Never use `--no-verify`. If it fails
  twice for a reason outside the in-scope files, STOP.
- **Secret scan false positives.** The hook's first stage (`vis secrets --staged`) reads any line
  holding the admin password-set endpoint path or the `admin-password-set` event name as a
  "generic password" (verified while writing this plan). Do not rename anything to dodge it.
  Append ` // secret-scanner:allow -- endpoint path or event name, not a credential` to exactly
  each flagged line in `audit.ts`, `audit-hooks.ts` and the test files. That is the repository's
  convention; see `vis.config.ts` around line 237 and the `sdks/*` test fixtures. If the scan
  flags a line holding anything else, STOP and report it.
- Do not push. Do not open a PR.

## Steps

### Step 1: Install, build, version check

`pnpm install`; `grep -m1 '"version"' packages/auth/node_modules/better-auth/package.json`;
`pnpm --filter "@lunora/auth..." run build`.

**Verify:** install and build exit 0; the version line is `"version": "1.7.16"`.

### Step 2: The completeness test (create `audit-endpoint-coverage.test.ts`)

Create `packages/auth/__tests__/audit-endpoint-coverage.test.ts`. Start it with a docblock of a
few lines saying why: `eventForPath` classifies by path, and a plugin endpoint it does not know
writes no audit row, so every endpoint the re-exported plugins serve must be classified
deliberately, and a better-auth upgrade that adds one fails here.

Build the enumerated set:

```ts
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";

import { eventForPath } from "../src/audit-hooks";
import {
    admin,
    anonymous,
    apiKey,
    deviceAuthorization,
    emailOTP,
    magicLink,
    multiSession,
    oneTap,
    oneTimeToken,
    passkey,
    phoneNumber,
    siwe,
    twoFactor,
    username,
} from "../src/plugins";
import { sso } from "../src/plugins-enterprise";

const pathsOf = (endpoints: Record<string, { path?: string }> | undefined): string[] =>
    Object.values(endpoints ?? {}).flatMap((endpoint) => (typeof endpoint.path === "string" ? [endpoint.path] : []));
```

- Core: `pathsOf(betterAuth({ baseURL: "http://localhost", database: memoryAdapter({}), emailAndPassword: { enabled: true }, secret: "x".repeat(32) }).api as never)`.
  If better-auth logs a low-entropy secret warning, silence `console.warn` with `vi.spyOn` in
  that test, as `invite-only.behaviour.test.ts` does.
- Plugins: `pathsOf(plugin.endpoints)` for `passkey()`, `oneTap()`, `admin()`, `oneTimeToken()`,
  `phoneNumber({ sendOTP: () => {} })`,
  `siwe({ domain: "example.com", getNonce: async () => "nonce", verifyMessage: async () => true })`,
  `anonymous()`, `emailOTP({ sendVerificationOTP: async () => {} })`,
  `magicLink({ sendMagicLink: async () => {} })`, `username()`, `multiSession()`,
  `deviceAuthorization()`, `twoFactor()`, `sso()`, `apiKey()`. If a constructor's types demand
  more options, add the minimum the type checker asks for. If one throws at construction,
  STOP and report.

`EXPECTED: Record<string, AuthAuditEvent | undefined>` has exactly these keys (§4 plus the
existing behaviour). `undefined` means deliberately not audited:

```
/account-info: undefined            /callback/:id: sign-in               /change-email: email-change
/change-password: password-change   /delete-user: user-delete            /delete-user/callback: user-delete
/error: undefined                   /get-access-token: undefined         /get-session: undefined
/link-social: account-link          /list-accounts: undefined            /list-sessions: undefined
/ok: undefined                      /refresh-token: token-refresh        /request-password-reset: password-reset
/reset-password: password-reset     /reset-password/:token: undefined    /revoke-other-sessions: session-revoke
/revoke-session: session-revoke     /revoke-sessions: session-revoke     /send-verification-email: undefined
/sign-in/email: sign-in             /sign-in/social: sign-in-initiated   /sign-out: sign-out
/sign-up/email: sign-up             /unlink-account: account-unlink      /update-session: undefined
/update-user: undefined             /verify-email: email-verification    /verify-password: undefined
/passkey/generate-register-options: undefined      /passkey/generate-authenticate-options: undefined
/passkey/verify-registration: passkey-add          /passkey/verify-authentication: sign-in
/passkey/list-user-passkeys: undefined             /passkey/delete-passkey: passkey-remove
/passkey/update-passkey: undefined                 /one-tap/callback: sign-in
/admin/set-role: admin-role-change                 /admin/get-user: undefined
/admin/create-user: admin-user-create              /admin/update-user: admin-user-update
/admin/list-users: undefined                       /admin/list-user-sessions: undefined
/admin/unban-user: admin-user-unban                /admin/ban-user: admin-user-ban
/admin/impersonate-user: admin-impersonate-start   /admin/stop-impersonating: admin-impersonate-stop
/admin/revoke-user-session: admin-session-revoke   /admin/revoke-user-sessions: admin-session-revoke
/admin/remove-user: admin-user-remove
/admin/has-permission: undefined                   /one-time-token/generate: one-time-token-create
/one-time-token/verify: sign-in                    /sign-in/phone-number: sign-in
/phone-number/send-otp: undefined                  /phone-number/verify: phone-verification
/phone-number/request-password-reset: password-reset   /phone-number/reset-password: password-reset
/siwe/nonce: undefined   /siwe/get-nonce: undefined   /siwe/verify: sign-in
/sign-in/anonymous: sign-in                        /delete-anonymous-user: user-delete
/email-otp/send-verification-otp: undefined        /email-otp/check-verification-otp: undefined
/email-otp/verify-email: email-verification        /sign-in/email-otp: sign-in
/email-otp/request-password-reset: password-reset  /forget-password/email-otp: password-reset
/email-otp/reset-password: password-reset          /email-otp/request-email-change: undefined
/email-otp/change-email: email-change              /sign-in/magic-link: sign-in-initiated
/magic-link/verify: sign-in                        /sign-in/username: sign-in
/is-username-available: undefined                  /multi-session/list-device-sessions: undefined
/multi-session/set-active: session-switch          /multi-session/revoke: session-revoke
/device/code: undefined   /device/token: sign-in   /device: undefined
/device/approve: device-approve                    /device/deny: device-deny
/two-factor/get-totp-uri: undefined                /two-factor/verify-totp: sign-in
/two-factor/send-otp: undefined                    /two-factor/verify-otp: sign-in
/two-factor/verify-backup-code: sign-in            /two-factor/generate-backup-codes: mfa-backup-codes-regenerate
/two-factor/enable: mfa-enable                     /two-factor/disable: mfa-disable
/sso/saml2/sp/metadata: undefined                  /sso/register: undefined (deferred)
/sign-in/sso: sign-in-initiated                    /sso/callback/:providerId: sign-in
/sso/callback: sign-in                             /sso/saml2/sp/acs/:providerId: sign-in
/sso/saml2/sp/slo/:providerId: sign-out            /sso/saml2/logout/:providerId: sign-out
/sso/providers: undefined (deferred)               /sso/get-provider: undefined (deferred)
/sso/update-provider: undefined (deferred)         /sso/delete-provider: undefined (deferred)
/api-key/create: api-key-create                    /api-key/get: undefined
/api-key/update: api-key-update                    /api-key/delete: api-key-delete
/api-key/list: undefined
```

One more key belongs in `EXPECTED`: `/admin/set-user-password` with the value `admin-password-set`. <!-- secret-scanner:allow -->

Write it as a TypeScript object literal with one key per line (sorted keys if the linter asks).
Put a short `// deferred: IdP configuration, not a user credential — see plan 561 §4.6` comment
above the SSO management keys. Tests:

1. "classifies every endpoint the re-exported plugins serve, and nothing is unaccounted for":
   `expect([...new Set(enumerated)].toSorted()).toStrictEqual(Object.keys(EXPECTED).toSorted())`.
2. "classifies each endpoint as recorded in EXPECTED": for each `[path, event]`,
   `expect(eventForPath(path), path).toBe(event)`.
3. "classifies the same with an app basePath in front": the same loop over
   `` `/api/auth${path}` ``.

Use `expect.hasAssertions()` for the loop tests.

**Verify (must be RED):** `pnpm --filter "@lunora/auth" exec vitest run __tests__/audit-endpoint-coverage.test.ts`.
Test 1 passes. If it fails, the enumerated set differs from the table: STOP and report the diff
(the installed better-auth is not the one this plan was written against). Tests 2 and 3 FAIL
on the new rows (for example `/admin/impersonate-user`, `/device/token`). Record the output.

### Step 3: Builder tests in `audit.test.ts`

In `describe("buildAuditEntry — classification & extraction", …)` add:

1. "records the impersonated user's id on an admin action, and never other body fields":
   `buildAuditEntry({ path: "/admin/impersonate-user", body: { userId: "user_42" } })?.detail`
   equals `{ path: "/admin/impersonate-user", targetUserId: "user_42" }`. Then the admin
   password-set endpoint: declare two module-level constants in the test file, `SET_PASSWORD_PATH`
   (the `/admin/set-user-…` path from §4.4) and `NEW_PASSWORD` (any 16-character string), and
   assert that `buildAuditEntry({ path: SET_PASSWORD_PATH, body: { newPassword: NEW_PASSWORD, userId: "user_42" } })?.detail`
   equals `{ path: SET_PASSWORD_PATH, targetUserId: "user_42" }`. The constants keep the
   credential-shaped literals off the assertion lines (see the secret-scan note in "Git workflow").
2. "does not add targetUserId to a non-admin event": `/sign-out` with `body: { userId: "x" }`
   has detail `{ path: "/sign-out" }`.
3. "keeps targetUserId through redaction on a persisted admin row": use the file's
   `executor` and `appendAuthAuditEntry(executor, buildAuditEntry({ path: "/admin/ban-user", body: { userId: "user_42" } })!)`,
   then `readAuthAuditLog` (see the existing "records sign-in…" test for the call) and assert
   the row's `detail.targetUserId` is `"user_42"`.

**Verify (must be RED):** `pnpm --filter "@lunora/auth" exec vitest run __tests__/audit.test.ts`.
The three new tests fail and every existing test passes.

### Step 4: Implement

- `packages/auth/src/audit.ts`: add the 23 names from §4.3 to `AuthAuditEvent`, keeping the
  members alphabetical and `| (string & {})` last. Keep the existing comment on
  `sign-in-initiated`. Add one short comment above the `admin-*` group: an operator acting on
  another account; the subject's id is in `detail.targetUserId`.
- `packages/auth/src/audit-hooks.ts`:
    - Add `SUFFIX_EVENTS` (§4.4) above `eventForPath`, with a short comment saying why it is
      exact-suffix and checked first (the `/device/token` vs `ends("/token")` ordering, and
      `basePath` safety).
    - At the top of `eventForPath`, after `ends` is defined:
      `const exact = SUFFIX_EVENTS.find(([suffix]) => ends(suffix)); if (exact !== undefined) return exact[1];`.
    - In `buildAuditEntry`, compute `targetUserId` only when `event.startsWith("admin-")` and
      `typeof context.body?.["userId"] === "string"` and it is non-empty; spread it into `detail`
      next to `path`.
    - In `eventForPath`'s docblock, add a short paragraph saying the plugin endpoints are pinned by
      `__tests__/audit-endpoint-coverage.test.ts` against the installed better-auth. In
      `authAuditHook`'s behaviour-change table, add a row: `/device/token` → `token-refresh` →
      `sign-in`.
    - Comments say why. No `.js` import extensions. Exports unchanged.

**Verify:** `pnpm --filter "@lunora/auth" exec vitest run __tests__/audit-endpoint-coverage.test.ts __tests__/audit.test.ts __tests__/audit-hooks.behaviour.test.ts`
→ all pass.

### Step 5: Hand-edit the API snapshot

In `api-snapshots/auth.api.md`, replace the single `type AuthAuditEvent = …;` line (around
line 331) with **one line** (no wrapping) of the same shape: `type AuthAuditEvent = ` followed
by every member of the new union in `audit.ts`, each double-quoted, separated by a space, a pipe and a space
(exactly as in the current line), and ending with ` | (string & {});`. That is the 13 existing names plus the 23 from §4.3, 36 in all, in
alphabetical order. The file is excluded from the secret scan, so no marker is needed there.

If the union in `audit.ts` ends up in a different order (for example because the linter sorted
it differently), make the snapshot line follow the source order and say so in your report.

**Verify:** `git diff -- api-snapshots/auth.api.md` shows exactly one line removed and one added.

### Step 6: Gates

oxfmt on the changed `.ts` files, then `lint:types`, `lint:eslint`,
`pnpm --filter "@lunora/auth" run test`.

**Verify:** each exits 0.

### Step 7: Commit

Stage exactly the in-scope files and commit with the message above.

**Verify:** `git status --porcelain` is empty; `git diff --stat 36c32cc1b..HEAD` lists only
in-scope files.

## Test plan

- New file `audit-endpoint-coverage.test.ts` (3 tests): completeness plus per-path
  classification, with and without a `basePath`.
- 3 new builder tests in `audit.test.ts`, modelled on that file's classification and store tests.
- Red-without-fix: Steps 2 and 3 run before Step 4 and must fail where stated.

## Done criteria (all must hold)

- [ ] `pnpm --filter "@lunora/auth" run test` exits 0, including the new tests
- [ ] `pnpm --filter "@lunora/auth" run lint:types` and `run lint:eslint` exit 0
- [ ] `grep -c '"/admin/' packages/auth/src/audit-hooks.ts` prints at least `11`
- [ ] `git diff 36c32cc1b..HEAD -- api-snapshots/auth.api.md` changes exactly one line
- [ ] `git diff --stat 36c32cc1b..HEAD` lists only in-scope files
- [ ] Reviewer only: `pnpm run build:packages && pnpm run api:check` passes on this branch

## 8. Risks & STOP conditions

- **STOP** if better-auth is not 1.7.16, or if Step 2 test 1 shows a different endpoint set.
  Report the symmetric difference.
- **STOP** if an existing test asserts `/device/token` (or any path in §4.4) classifies
  differently from §4.4.
- **STOP** if redaction removes `targetUserId` (Step 3 test 3 stays red after Step 4).
- **STOP** if a plugin constructor needs a real secret, network or database to build.
- **STOP** if a step's verification fails twice after a reasonable fix attempt.
- **Risk:** more rows per request on busy admin dashboards. Only mutating admin endpoints are
  mapped; the list/get reads stay `undefined`.

## 9. Open questions

1. Owner: audit coverage for the deferred plugins (`organization`, `oauthProvider`, `scim`,
   SSO provider management). Each needs its own event names. Add them to the coverage test's
   enumerated set when they are mapped.
2. Owner: `/update-user` stays unaudited (core refuses email changes there; it carries profile
   fields). Revisit if apps add security-relevant `additionalFields`.
