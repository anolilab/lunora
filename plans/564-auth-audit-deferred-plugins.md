# Plan 564 — Audit the organization, OAuth-provider, SCIM and SSO-management endpoints

> **Executor instructions.** Follow this plan step by step. Run every `Verify:` command and
> confirm the expected result before moving on. Touch only the files listed under "In scope".
> If any STOP condition occurs, stop and report; do not improvise. Do not update
> `plans/README.md`. **Every change is a new commit: never amend, rebase or force-push.**
>
> **Drift check (run first):** `git log --oneline -1` must print `cb359bf05 …` and
> `grep -m1 '"version"' packages/auth/node_modules/better-auth/package.json` (after install) must
> print `"version": "1.7.16"`. Anything else is a STOP condition.

**Baseline:** `cb359bf05`, the tip of `security/improve-561-auth-audit-coverage` (PR #1546, not
merged). This plan's branch `security/improve-564-auth-audit-plugin-coverage` stacks on it; its PR
should target the 561 branch until #1546 merges.
**Status:** DONE (APPROVED on review 2026-11-11; branch `security/improve-564-auth-audit-plugin-coverage`, commit `88c1da32a` on top of `cb359bf05`, not pushed; reviewer ran `build:packages` + `api:check` (pass). Errata found in execution: there are 13 method rows, not 11, and `/oauth2/end-session/confirm` needs its own suffix row)
**Priority / Effort / Risk:** P2 / M / LOW. **Category:** security. **Depends on:** plan 561.
**Decision:** owner, 2026-11-11: extend the audit mapping to the plugins plan 561 deferred.

## 0. Headline finding

After plan 561, `authAuditHook` records the plugins that issue sessions or change one user's
credentials. It still writes no row for the `organization` plugin (create/delete organizations,
invite/remove members, change roles, teams), the OAuth provider (`oauthProvider`: token issue and
revoke, client create/rotate/delete, consent, resource admin), SCIM provisioning (create, update
and delete users and groups), or SSO provider management (`/sso/register`, `/sso/update-provider`,
`/sso/delete-provider`). All of these are privileged changes.

## 1. Current state (audit)

Branch tip `cb359bf05`. `packages/auth/src/audit-hooks.ts`:

- `SUFFIX_EVENTS` (exact-suffix table) is checked first by `eventForPath(path)`, then
  `branchEventForPath(normalized)` (substring branches; `ends("/refresh-token") || ends("/token")`
  gives `token-refresh`).
- `resolveTargetUserId(context, event)` copies `body.userId` into `detail.targetUserId` for any
  event starting with `admin-`.
- `buildAuditEntry` writes `detail: { path, ...targetUserId }`.
- `AuditHookContext` has `body`, `context`, `headers`, `path`, `request`. No `method`, no `params`.

`packages/auth/__tests__/audit-endpoint-coverage.test.ts`: a path-keyed `EXPECTED` map for
core + 15 plugins. Its SSO-management keys are pinned `undefined` under the comment
`// deferred: IdP configuration, not a user credential — see plan 561 §4.6`.

Verified against the installed better-auth 1.7.16 (`@better-auth/oauth-provider`,
`@better-auth/scim`, `better-auth/plugins/organization`, all 1.7.16):

- **The hook sees the HTTP method over HTTP, not on a direct `auth.api.*` call.** A probe hook
  saw `ctx.method === "GET"` / `"POST"` for `auth.handler(new Request(…))` and `undefined` for
  `auth.api.ok()`.
- **The hook sees path params** as `ctx.params` (probe: `/reset-password/:token` gave
  `params: { token: "abc123" }`). Params can carry secrets, so only allow-listed ids may be copied.
- `ctx.path` is the template (`endpoint.path`), e.g. `/scim/v2/Users/:userId`.
- Several paths are served by **different endpoints per method**:
  `/admin/oauth2/resources` (GET list / POST create), `/admin/oauth2/resources/:identifier`
  (GET/PATCH/DELETE), `/admin/oauth2/resources/:identifier/clients/:client_id` (POST/DELETE),
  `/scim/v2/Users` and `/scim/v2/Groups` (GET/POST), `/scim/v2/Users/:userId` and
  `/scim/v2/Groups/:groupId` (GET/PATCH/PUT/DELETE). A path-only classifier cannot tell a read from
  a write there.
- `/oauth2/end-session` is **one** endpoint answering GET and POST. It may end the session at once
  or answer with a confirmation step; `/oauth2/end-session/confirm` ends it.
- SCIM's nine management endpoints (managed connections, credential rotation, decommission,
  reconcile) have **no HTTP path**; they are server-only and this hook cannot see them.
- `scim()` throws at construction without a connection, a `verifyBearerToken` or managed
  connections; the test builds it with `{ connections: [], authentication: { verifyBearerToken: async () => null } }`.
- The secret scanner was probed with every new path and event name in this plan; none is flagged.

## 2. Existing seams

`SUFFIX_EVENTS`, `eventForPath`, `branchEventForPath`, `resolveTargetUserId` and `buildAuditEntry`
in `audit-hooks.ts`, and the coverage test's `pathsOf` / `enumerated` / `EXPECTED` structure.
Extend them; do not add a second classifier.

## 3. Contract to preserve

- Every existing test passes unchanged, except the SSO-management values in `EXPECTED` and their
  "deferred" comment, which this plan changes on purpose.
- `eventForPath(path)` with no method returns exactly what it returns today for every path in the
  561 `EXPECTED` map.
- `authAuditHook` still returns `undefined`; `targetEmail` rules are unchanged; `admin-*` keeps its
  `targetUserId`.

## 4. Design decisions

1. **Method-aware rows only where a path has several endpoints.** Add
   `const METHOD_EVENTS: ReadonlyArray<readonly [method: string, suffix: string, event: AuthAuditEvent]>`,
   checked **before** `SUFFIX_EVENTS`. `eventForPath(path: string, method?: string)` gains an
   optional `method`. A method row matches only when `method` (upper-cased) equals the row's
   method. With no method (a direct server call) no method row matches, so those multiplexed paths
   return `undefined`. That limit is deliberate (server code is trusted) and pinned by a test.
   Every other new row is path-only and goes into `SUFFIX_EVENTS`.
2. **Template matching.** A table suffix may contain `:param` segments. Each `:param` matches exactly
   one path segment (`[^/]+`), comparison is case-insensitive, and the suffix is anchored at the end.
   This matches both the template path the hook receives and a basePath-prefixed concrete path.
   The existing 561 rows (no params) behave exactly as before.
3. **`/oauth2/token` moves from `token-refresh` to `oauth-token-issue`** (it issues access and
   refresh tokens to OAuth clients; behaviour change, noted in the commit body). `/device/token`
   stays `sign-in` for both device plugins; the hook cannot tell them apart and both issue a grant.
4. **`/oauth2/end-session` and `/oauth2/end-session/confirm` are both `sign-out`.** When
   end-session answers with a confirmation step, one extra `sign-out` row is written. Rejected: a
   separate "requested" event, because the hook cannot tell from the response which branch ran,
   and a missed termination is worse than an extra row (561's rule).
5. **`/organization/set-active` and `/organization/set-active-team` are `org-switch`**, consistent
   with 561's `session-switch`: they change the session's authorization context.
6. **OAuth admin events are named `oauth-*`, not `admin-*`**, so they do not inherit 561's
   `targetUserId` rule.
7. **`detail` ids, by event family, from an allow-list only.** Copy a value only if it is a
   non-empty string, cut to 256 characters. Never copy anything else from `body`, `params`,
   `query` or `context.returned` (`/oauth2/register` and `rotate-secret` return secrets, and
   invitations carry emails).

    | Event prefix    | Source → `detail` key                                                                                                                                                  |
    | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | `org-`          | `body.organizationId` → `organizationId`; `body.teamId` → `teamId`; `body.invitationId` → `invitationId`; `body.memberId` → `memberId`; `body.userId` → `targetUserId` |
    | `oauth-`        | `body.client_id` or `params.client_id` → `clientId`; `params.identifier` → `resourceIdentifier`                                                                        |
    | `scim-`         | `params.userId` → `scimUserId` (a SCIM resource id, not necessarily the better-auth user id); `params.groupId` → `scimGroupId`                                         |
    | `sso-provider-` | `body.providerId` → `providerId`                                                                                                                                       |

    `admin-` keeps `body.userId` → `targetUserId` (561, unchanged).

8. **SSO management is mapped**: `/sso/register` → `sso-provider-register`, `/sso/update-provider`
   → `sso-provider-update`, `/sso/delete-provider` → `sso-provider-delete`; `/sso/providers` and
   `/sso/get-provider` stay `undefined` (reads). The "deferred" comment goes.
9. **New `AuthAuditEvent` names (40)**, added alphabetically:
   `oauth-client-create`, `oauth-client-delete`, `oauth-client-keys-rotate`,
   `oauth-client-secret-rotate`, `oauth-client-update`, `oauth-consent`, `oauth-consent-revoke`,
   `oauth-consent-update`, `oauth-resource-client-link`, `oauth-resource-client-unlink`,
   `oauth-resource-create`, `oauth-resource-delete`, `oauth-resource-update`, `oauth-token-issue`,
   `oauth-token-revoke`, `org-create`, `org-delete`, `org-invitation-accept`,
   `org-invitation-cancel`, `org-invitation-create`, `org-invitation-reject`, `org-member-leave`,
   `org-member-remove`, `org-member-role-change`, `org-switch`, `org-team-create`,
   `org-team-member-add`, `org-team-member-remove`, `org-team-remove`, `org-team-update`,
   `org-update`, `scim-group-create`, `scim-group-delete`, `scim-group-update`,
   `scim-user-create`, `scim-user-delete`, `scim-user-update`, `sso-provider-delete`,
   `sso-provider-register`, `sso-provider-update`.

### 4.10 The full classification of the new plugins (generated from the installed packages)

Keys are `"METHOD /path"`, one per (method, endpoint), from `organization({ teams: { enabled: true } })`,
`oauthProvider({ loginPage: "/login", consentPage: "/consent" })`, `oauthDeviceAuthorization({})`
and the SCIM construction in §1. 90 keys, 49 mapped.

```text
DELETE /admin/oauth2/resources/:identifier: oauth-resource-delete
DELETE /admin/oauth2/resources/:identifier/clients/:client_id: oauth-resource-client-unlink
DELETE /scim/v2/Groups/:groupId: scim-group-delete
DELETE /scim/v2/Users/:userId: scim-user-delete
GET /.well-known/oauth-authorization-server: undefined
GET /.well-known/openid-configuration: undefined
GET /admin/oauth2/resources: undefined
GET /admin/oauth2/resources/:identifier: undefined
GET /device: undefined
GET /oauth2/authorize: undefined
GET /oauth2/end-session: sign-out
GET /oauth2/get-client: undefined
GET /oauth2/get-clients: undefined
GET /oauth2/get-consent: undefined
GET /oauth2/get-consents: undefined
GET /oauth2/public-client: undefined
GET /oauth2/userinfo: undefined
GET /organization/get-active-member: undefined
GET /organization/get-active-member-role: undefined
GET /organization/get-full-organization: undefined
GET /organization/get-invitation: undefined
GET /organization/get-organization: undefined
GET /organization/list: undefined
GET /organization/list-invitations: undefined
GET /organization/list-members: undefined
GET /organization/list-team-members: undefined
GET /organization/list-teams: undefined
GET /organization/list-user-invitations: undefined
GET /organization/list-user-teams: undefined
GET /scim/v2/Groups: undefined
GET /scim/v2/Groups/:groupId: undefined
GET /scim/v2/ResourceTypes: undefined
GET /scim/v2/ResourceTypes/:resourceTypeId: undefined
GET /scim/v2/Schemas: undefined
GET /scim/v2/Schemas/:schemaId: undefined
GET /scim/v2/ServiceProviderConfig: undefined
GET /scim/v2/Users: undefined
GET /scim/v2/Users/:userId: undefined
PATCH /admin/oauth2/resources/:identifier: oauth-resource-update
PATCH /admin/oauth2/update-client: oauth-client-update
PATCH /scim/v2/Groups/:groupId: scim-group-update
PATCH /scim/v2/Users/:userId: scim-user-update
POST /admin/oauth2/create-client: oauth-client-create
POST /admin/oauth2/resources: oauth-resource-create
POST /admin/oauth2/resources/:identifier/clients/:client_id: oauth-resource-client-link
POST /device/approve: device-approve
POST /device/code: undefined
POST /device/deny: device-deny
POST /device/token: sign-in
POST /oauth2/authorize: undefined
POST /oauth2/client/rotate-keys: oauth-client-keys-rotate
POST /oauth2/client/rotate-secret: oauth-client-secret-rotate
POST /oauth2/consent: oauth-consent
POST /oauth2/continue: undefined
POST /oauth2/create-client: oauth-client-create
POST /oauth2/delete-client: oauth-client-delete
POST /oauth2/delete-consent: oauth-consent-revoke
POST /oauth2/end-session: sign-out
POST /oauth2/end-session/confirm: sign-out
POST /oauth2/introspect: undefined
POST /oauth2/public-client-prelogin: undefined
POST /oauth2/register: oauth-client-create
POST /oauth2/revoke: oauth-token-revoke
POST /oauth2/token: oauth-token-issue
POST /oauth2/update-client: oauth-client-update
POST /oauth2/update-consent: oauth-consent-update
POST /oauth2/userinfo: undefined
POST /organization/accept-invitation: org-invitation-accept
POST /organization/add-team-member: org-team-member-add
POST /organization/cancel-invitation: org-invitation-cancel
POST /organization/check-slug: undefined
POST /organization/create: org-create
POST /organization/create-team: org-team-create
POST /organization/delete: org-delete
POST /organization/has-permission: undefined
POST /organization/invite-member: org-invitation-create
POST /organization/leave: org-member-leave
POST /organization/reject-invitation: org-invitation-reject
POST /organization/remove-member: org-member-remove
POST /organization/remove-team: org-team-remove
POST /organization/remove-team-member: org-team-member-remove
POST /organization/set-active: org-switch
POST /organization/set-active-team: org-switch
POST /organization/update: org-update
POST /organization/update-member-role: org-member-role-change
POST /organization/update-team: org-team-update
POST /scim/v2/Groups: scim-group-create
POST /scim/v2/Users: scim-user-create
PUT /scim/v2/Groups/:groupId: scim-group-update
PUT /scim/v2/Users/:userId: scim-user-update
```

**Which rows go where.** Method rows (`METHOD_EVENTS`) are exactly the mapped keys on these seven
multiplexed paths: `/admin/oauth2/resources`, `/admin/oauth2/resources/:identifier`,
`/admin/oauth2/resources/:identifier/clients/:client_id`, `/scim/v2/Users`,
`/scim/v2/Users/:userId`, `/scim/v2/Groups`, `/scim/v2/Groups/:groupId` (11 rows; PATCH and PUT
are separate rows). Every other mapped key becomes a path-only row in `SUFFIX_EVENTS`, without the
method: `/oauth2/end-session` once, `/device/*` already exists from 561 (do not duplicate), and
`/oauth2/create-client` also covers `/admin/oauth2/create-client` by suffix, as
`/oauth2/update-client` covers `/admin/oauth2/update-client` (add each pair once, as the two
shorter suffixes). Plus the three SSO rows from §4.8.

## 5. Workstreams

Single workstream (M), in the steps below.

## 6. Platform parity

Not applicable: no `ctx.*` surface or binding. better-auth hook only.

## 7. Phasing & ordering

| Phase | Work                      | Gate                                                  |
| ----- | ------------------------- | ----------------------------------------------------- |
| 0     | install, version, build   | 1.7.16; `pnpm --filter "@lunora/auth..." run build`   |
| 1     | tests first (red)         | new coverage tests and builder tests fail             |
| 2     | implement                 | coverage, audit and audit-hooks behaviour tests green |
| 3     | snapshot hand-edit, gates | lint, types, auth tests                               |

## Commands you will need

Prefix every shell call with `cd <worktree> &&`.

| Purpose             | Command                                                                 | Expected           |
| ------------------- | ----------------------------------------------------------------------- | ------------------ |
| Install             | `pnpm install`                                                          | exit 0             |
| Build auth + deps   | `pnpm --filter "@lunora/auth..." run build`                             | exit 0             |
| One test file       | `pnpm --filter "@lunora/auth" exec vitest run __tests__/<file>.test.ts` | all pass           |
| Package tests       | `pnpm --filter "@lunora/auth" run test`                                 | all pass           |
| Types               | `pnpm --filter "@lunora/auth" run lint:types`                           | exit 0             |
| Format              | `pnpm exec oxfmt <changed .ts files>`                                   | exit 0             |
| Lint (after format) | `pnpm --filter "@lunora/auth" run lint:eslint`                          | exit 0, 0 warnings |

**Forbidden:** `pnpm run build`, `pnpm run build:packages`, root `pnpm run test`,
`pnpm run test:workerd`, `pnpm run api:check`, `pnpm run api:update`, any `pnpm -r …`. Your
reviewer runs `api:check`. workerd is not needed: the audit table SQL is unchanged.

## Scope

**In scope:**

- `packages/auth/src/audit-hooks.ts`
- `packages/auth/src/audit.ts` (the `AuthAuditEvent` union only)
- `packages/auth/__tests__/audit-endpoint-coverage.test.ts`
- `packages/auth/__tests__/audit.test.ts`
- `api-snapshots/auth.api.md` (three places, Step 5)

**Out of scope:** `plugins.ts`, `plugins-enterprise.ts`, the audit table and redaction,
`packages/studio/**`, `admin.ts`, `CHANGELOG.md`, `plans/**`.

## Git workflow

- Branch `security/improve-564-auth-audit-plugin-coverage` (already checked out). Do not switch.
- Stage explicit paths only. New commits only; never `--amend`, rebase, force or `--no-verify`.
- Message (header ≤ 100, body lines ≤ 100):

    ```
    security(auth): audit organization, oauth provider, scim and sso-management endpoints

    The audit hook now records organization, member, invitation and team changes, OAuth client,
    consent, token and resource-admin operations, SCIM user and group writes, and SSO provider
    registration, update and removal. Rows carry allow-listed ids only. Classification is
    method-aware for paths that serve several endpoints.

    BREAKING CHANGE: new AuthAuditEvent names; /oauth2/token is recorded as oauth-token-issue
    instead of token-refresh; eventForPath takes an optional method.
    ```

    Add any attribution trailer your environment requires, after a blank line.

- If the pre-commit hook fails, fix the reported problem in an in-scope file and commit again;
  twice for a reason outside scope → STOP. If the secret scan flags a line, STOP and report it
  (none is expected; see §1).

## Steps

### Step 1: Install, version, build

`pnpm install`; the version grep; `pnpm --filter "@lunora/auth..." run build`.
**Verify:** exit 0; `"version": "1.7.16"`; `git log --oneline -1` starts with `cb359bf05`.

### Step 2: Coverage test first

In `packages/auth/__tests__/audit-endpoint-coverage.test.ts`:

1. Change the five SSO-management values in `EXPECTED` per §4.8 and delete the
   `// deferred: …` comment.
2. Import `oauthDeviceAuthorization`, `oauthProvider`, `organization` and `scim` from
   `../src/plugins`. Add a helper `methodKeysOf(endpoints)` returning `"METHOD /path"` for each
   endpoint with a string `path`, one key per method (a method array expands to several keys).
3. Build `enumeratedByMethod` from the four constructors in §4.10 (exact options as written there
   and in §1).
4. Add `EXPECTED_BY_METHOD: Record<string, AuthAuditEvent | undefined>` holding exactly the 90
   keys and values of §4.10, one key per line.
5. Tests (in the existing `describe`, `expect.hasAssertions()` for loops):
    - "classifies every organization, OAuth-provider and SCIM endpoint, and nothing is unaccounted for":
      sorted set of `enumeratedByMethod` equals the sorted keys of `EXPECTED_BY_METHOD`
      (use the file's `localeCompare` comparator).
    - "classifies each of those endpoints by method and path": for each key, split into
      `method` and `path`; `expect(eventForPath(path, method), key).toBe(event)`; and the same with
      `` `/api/auth${path}` ``.
    - "leaves a multiplexed path unclassified when no method is known (direct server calls)":
      `eventForPath("/scim/v2/Users")`, `eventForPath("/scim/v2/Users/:userId")` and
      `eventForPath("/admin/oauth2/resources/:identifier")` are all `undefined`.
    - "matches a concrete path against a parameterised row": `eventForPath("/api/auth/scim/v2/Users/u-123", "DELETE")`
      is `scim-user-delete`, and `eventForPath("/api/auth/scim/v2/Users/u-123", "GET")` is `undefined`.

**Verify (RED):** `pnpm --filter "@lunora/auth" exec vitest run __tests__/audit-endpoint-coverage.test.ts`.
The new "nothing is unaccounted for" test **passes** (if it fails, STOP and report the symmetric
difference: the installed packages differ from this plan). The per-method test, the concrete-path
test and the existing per-path test (SSO rows) fail. The type check may also flag
`eventForPath(path, method)`; that is part of the red. Record the output.

### Step 3: Builder tests in `audit.test.ts`

In `describe("buildAuditEntry — classification & extraction", …)` add:

1. "records allow-listed ids for an organization change, and nothing else from the body":
   `buildAuditEntry({ body: { email: "invitee@example.com", organizationId: "org_1", role: "admin" }, method: "POST", path: "/api/auth/organization/invite-member" })?.detail`
   equals `{ organizationId: "org_1", path: "/api/auth/organization/invite-member" }`, and its
   `event` is `org-invitation-create`.
2. "records the SCIM resource id from the path params on a SCIM write":
   `buildAuditEntry({ method: "DELETE", params: { userId: "scim-u-1" }, path: "/scim/v2/Users/:userId" })`
   has `event` `scim-user-delete` and `detail` `{ path: "/scim/v2/Users/:userId", scimUserId: "scim-u-1" }`.
3. "records the client id on an OAuth client operation and never a secret-shaped param":
   `buildAuditEntry({ body: { client_id: "c-1" }, method: "POST", params: { token: "t-should-not-appear" }, path: "/oauth2/client/rotate-secret" })?.detail`
   equals `{ clientId: "c-1", path: "/oauth2/client/rotate-secret" }`.
4. "does not treat an oauth admin event as an admin-user event":
   `buildAuditEntry({ body: { userId: "u-9" }, method: "POST", path: "/admin/oauth2/create-client" })?.detail`
   has no `targetUserId`, and the event is `oauth-client-create`.

**Verify (RED):** `pnpm --filter "@lunora/auth" exec vitest run __tests__/audit.test.ts`: the four
new tests fail (type errors on `method`/`params` count as red); existing tests pass.

### Step 4: Implement

- `audit.ts`: add the 40 names of §4.9 to `AuthAuditEvent`, alphabetical, `| (string & {})` last.
- `audit-hooks.ts`:
    - `AuditHookContext`: add `method?: string;` and `params?: Record<string, unknown>;` in
      alphabetical position.
    - A small `suffixMatches(normalizedPath, suffix)` that implements §4.2 (build the regex once per
      row at module load, not per call). Use it for `METHOD_EVENTS` and `SUFFIX_EVENTS`.
    - `METHOD_EVENTS` and the new `SUFFIX_EVENTS` rows per §4.10 "Which rows go where", plus §4.8.
    - `eventForPath(path: string, method?: string)`: method rows first (only when `method` is a
      string), then `SUFFIX_EVENTS`, then `branchEventForPath`. Update its docblock with one
      paragraph on method rows and the direct-call limit (§4.1).
    - Replace `resolveTargetUserId` with a single `resolveDetailIds(context, event)` that returns the
      allow-listed ids of §4.7 (including 561's `admin-` rule unchanged) and spread it into `detail`.
      Cap each value at 256 characters. Comment why: params and bodies can carry tokens, secrets and
      emails, so only named ids are copied.
    - `buildAuditEntry` passes `context.method` to `eventForPath`.
    - Comments say why. No `.js` extensions. Exports unchanged apart from the optional parameter.

**Verify:** `pnpm --filter "@lunora/auth" exec vitest run __tests__/audit-endpoint-coverage.test.ts __tests__/audit.test.ts __tests__/audit-hooks.behaviour.test.ts`
→ all pass.

### Step 5: Hand-edit `api-snapshots/auth.api.md` (excluded from the secret scan)

1. Line `const eventForPath: (path: string) => AuthAuditEvent | undefined;` becomes
   `const eventForPath: (path: string, method?: string) => AuthAuditEvent | undefined;`
2. In `interface AuditHookContext` (appendix, around line 1963), insert after `headers?: Headers;`:

    ```text
        method?: string;
        params?: Record<string, unknown>;
    ```

3. Rewrite the single `type AuthAuditEvent = …;` line from the new union in source order, one line,
   members separated by a space, a pipe and a space, ending with ` | (string & {});`.

**Verify:** `git diff -- api-snapshots/auth.api.md` shows the three changes and nothing else.

### Step 6: Gates

oxfmt on changed `.ts` files, `lint:types`, `lint:eslint`, `pnpm --filter "@lunora/auth" run test`.
**Verify:** each exits 0.

### Step 7: Commit (new commit)

**Verify:** `git status --porcelain` empty; `git diff --stat cb359bf05..HEAD` lists only in-scope
files; `git log --oneline cb359bf05..HEAD` shows new commit(s) on top of `cb359bf05`.

## Done criteria

- [ ] `pnpm --filter "@lunora/auth" run test` exits 0
- [ ] `lint:types` and `lint:eslint` exit 0
- [ ] `EXPECTED_BY_METHOD` has 90 keys (`grep -cE '^    "(GET|POST|PUT|PATCH|DELETE) /' packages/auth/__tests__/audit-endpoint-coverage.test.ts` prints `90`)
- [ ] `grep -n "deferred" packages/auth/__tests__/audit-endpoint-coverage.test.ts` prints nothing
- [ ] `git diff --stat cb359bf05..HEAD` lists only in-scope files
- [ ] Reviewer: `build:packages` + `api:check` pass

## 8. Risks & STOP conditions

- **STOP** if better-auth or any `@better-auth/*` package is not 1.7.16, or the enumerated set
  differs from §4.10.
- **STOP** if an existing test's expectation changes other than the SSO-management values.
- **STOP** if a plugin constructor needs network, a database or a real secret.
- **STOP** if the secret scan flags any line.
- **Risk:** extra `sign-out` rows from `/oauth2/end-session` confirmation pages (§4.4).
- **Limit:** SCIM management endpoints (server-only) and direct server calls to multiplexed paths
  are not audited by this hook.

## 9. Open questions

1. None for execution.
