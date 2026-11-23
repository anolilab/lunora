# Plan 611: A banned user resolves to no identity, whatever credential they present

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 093c5e41f..HEAD -- packages/auth/src/session-identity.ts packages/auth/__tests__`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `093c5e41f` (2026-11-20)
**Status:** DONE, pushed: `fix/auth-banned-identity-and-key-revoke` (workerd: auth, runtime); PR #1634

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `093c5e41f`, 2026-11-20
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

`@lunora/auth` turns a better-auth session into the identity every Lunora function sees (`ctx.auth.userId`, role, org). An administrator bans a user to lock them out. Today a ban only deletes the user's session rows, and better-auth's `admin()` plugin only checks `banned` when a _new session row is created_. An API key (`apiKey({ enableSessionForAPIKeys: true })`) never creates a session row: the plugin builds an in-memory session from the key on every request. So a banned user's API keys keep resolving to their full identity — role and RLS scope included — until each key is deleted by hand. The same hole exists for a cookie session served from better-auth's cookie cache after a ban. One check in the resolver closes both.

## Current state

- `packages/auth/src/session-identity.ts` — builds the identity. `identityFromSession` (line 139) maps a session to claims; `resolveSessionIdentity` (line 210) is what both built-in wirings call. Neither reads `user.banned` / `user.banExpires`.
- `packages/auth/src/admin.ts:699-731` — `banUser` writes `banned: true`, `banExpires` (a `Date`, or `null` for a permanent ban) and `banReason` on the user row, then `deleteUserSessions(userId)`. `unbanUser` (line ~1369) writes `{ banExpires: null, banned: false, banReason: null }`. **Do not change this file.**
- The api-key plugin (dependency `@better-auth/api-key` 1.7.16, read-only) loads the user with `findUserById(apiKey.referenceId)` and returns `{ user, session }` from `getSession`; `user` is the full row, so it carries `banned` and `banExpires` when the `admin()` plugin is enabled, and neither column otherwise.

`session-identity.ts:52-56`:

```ts
/** The parts of a better-auth `getSession` result the identity is built from. */
interface SessionLike {
    session: { activeOrganizationId?: unknown; activeTeamId?: unknown; expiresAt?: unknown };
    user: { [column: string]: unknown; email?: unknown; id?: unknown; name?: unknown; role?: unknown };
}
```

`session-identity.ts:139-146`:

```ts
const identityFromSession = (session: SessionLike | null | undefined, claims: ReadonlyArray<string> = []): SessionIdentity | null => {
    const userId = nonEmpty(session?.user.id);

    if (session === null || session === undefined || userId === undefined) {
        // eslint-disable-next-line unicorn/no-null -- `null` is the resolver contract's anonymous sentinel
        return null;
    }
```

Existing structural test to copy: `packages/auth/__tests__/session-identity-api-key.behaviour.test.ts` (uses `createMemoryAuth` from `./helpers/memory-auth`, `apiKey` from `../src/plugins`, and `resolveSessionIdentity`). `packages/auth/__tests__/admin.api-keys.behaviour.test.ts` shows `createAuthAdmin(createAuth({ database: memoryAdapter(database), plugins: [admin(), apiKey()], ... }))` and `adminApi.createUser(...)`.

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

| Purpose                       | Command                                                                                            | Expected on success |
| ----------------------------- | -------------------------------------------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                                                   | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/auth..." run build`                                                        | exit 0              |
| One test file                 | `pnpm --filter "@lunora/auth" exec vitest run __tests__/session-identity-banned.behaviour.test.ts` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/auth" run test`                                                            | all pass            |
| Types                         | `pnpm --filter "@lunora/auth" run lint:types`                                                      | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/auth" run lint:eslint`                                                     | exit 0, 0 warnings  |

## Scope

**In scope** (the only files you may modify):

- `packages/auth/src/session-identity.ts`
- `packages/auth/__tests__/session-identity-banned.behaviour.test.ts` (create)
- `packages/auth/docs/plugins.mdx` (one sentence, step 3)

**Out of scope**:

- `packages/auth/src/admin.ts` — `banUser` must keep mirroring the plugin; do not make it delete or disable API keys (a temporary ban must not destroy keys).
- Anything in `node_modules`, `api-snapshots/`, other packages. The exported signatures of `identityFromSession` and `resolveSessionIdentity` must not change (so `pnpm run api:check` is unaffected).

## Git workflow

- Branch: `fix/536-banned-user-identity` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Example from this repo: `fix(auth): address API key review comments`. Use: `fix(auth): resolve a banned user to no identity`.
- Never use `--no-verify`. Do NOT push or open a PR.

## Steps

### Step 1: add the ban check to `identityFromSession`

In `packages/auth/src/session-identity.ts`:

1. Add a module-private helper above `identityFromSession`:

```ts
/**
 * Whether the `admin()` plugin's ban is in force. better-auth enforces a ban only
 * when a session row is created, so an API key (which never creates one) and a
 * cookie-cached session both outlive it unless the resolver checks too. A lapsed
 * `banExpires` reads as not banned, matching the plugin.
 */
const isBanned = (user: SessionLike["user"], now: number): boolean => {
    if (user["banned"] !== true) {
        return false;
    }

    const expires = user["banExpires"];

    if (expires === null || expires === undefined) {
        return true;
    }

    const expiresAtMs = expires instanceof Date ? expires.getTime() : new Date(expires as number | string).getTime();

    // An unreadable expiry must not lift a ban.
    return Number.isNaN(expiresAtMs) || expiresAtMs > now;
};
```

2. In `identityFromSession`, extend the existing anonymous guard so a banned user returns `null`: after computing `userId`, the condition becomes `session === null || session === undefined || userId === undefined || isBanned(session.user, Date.now())`. Keep the existing eslint-disable line as is.

Because `resolveSessionIdentity` calls `identityFromSession` first and returns early on `null`, no change is needed there.

**Verify**: `pnpm --filter "@lunora/auth" run lint:types` → exit 0.

### Step 2: write the behaviour test

Create `packages/auth/__tests__/session-identity-banned.behaviour.test.ts`. Test `identityFromSession` directly with plain session objects (it is exported from `../src/session-identity`), so no key minting is needed. Cases, each its own `it` with `expect.assertions`:

1. `banned: true`, no `banExpires` → `null`.
2. `banned: true`, `banExpires: null` → `null`.
3. `banned: true`, `banExpires` a `Date` one hour in the future → `null`.
4. `banned: true`, `banExpires` a `Date` one hour in the past → identity with the `userId`.
5. `banned: true`, `banExpires` an ISO string in the future → `null` (adapters that do not hydrate dates).
6. `banned: false` and the column absent → identity with the `userId`.

Use a fixed session shape: `{ session: { expiresAt: new Date(Date.now() + 3_600_000) }, user: { id: "u1", email: "a@example.test", ... } }`. For the past/future cases compute dates relative to `Date.now()` (no sleeping, no fake timers needed).

Then add one end-to-end case proving the real path: build `createAuthAdmin(createAuth({ baseURL: "http://localhost", database: memoryAdapter(database), plugins: [admin(), apiKey({ enableSessionForAPIKeys: true })], secret }))` exactly as `admin.api-keys.behaviour.test.ts` does, create a user with `adminApi.createUser`, call `adminApi.banUser({ userId })`, read the user row back from the in-memory `database["user"]` array and pass `{ session: {...}, user: row }` to `identityFromSession` → `null`; then `adminApi.unbanUser({ userId })`, re-read → identity. This pins the column names `banUser` really writes.

**Verify**: `pnpm --filter "@lunora/auth" exec vitest run __tests__/session-identity-banned.behaviour.test.ts` → all pass.
**Verify red**: temporarily remove `|| isBanned(...)` from the guard, rerun → cases 1, 2, 3, 5 and the banUser case fail. Restore.

### Step 3: document it

In `packages/auth/docs/plugins.mdx`, in the API keys section, directly after the paragraph that starts `**Revocation.**`, add one paragraph:

> **Bans.** A user banned through the `admin` plugin resolves to no identity for as long as the ban is in force, whether they present a cookie session or an API key. Their keys are kept, so lifting the ban restores them.

**Verify**: `pnpm exec prettier --check packages/auth/docs/plugins.mdx` → no changes needed.

## Test plan

Covered by step 2. Then run the whole package: `pnpm --filter "@lunora/auth" run test` → all pass (existing tests untouched).

## Done criteria

- [ ] `pnpm --filter "@lunora/auth" run lint:types` exits 0
- [ ] `pnpm --filter "@lunora/auth" run lint:eslint` exits 0
- [ ] `pnpm --filter "@lunora/auth" run test` exits 0, including the new file (≥7 tests)
- [ ] `rg -n "isBanned" packages/auth/src/session-identity.ts` shows the helper and its one call
- [ ] `git status --short` lists only the three in-scope files

## STOP conditions

- The excerpts above do not match `session-identity.ts`.
- The user row written by `banUser` in the in-memory database does not carry `banned`/`banExpires` under those names.
- Any existing auth test fails after step 1 (it would mean something relies on a banned user's identity).
- The fix seems to need a change in `admin.ts` or in the runtime package.

## Maintenance notes

- The worker memoises cookie-session identities for `LUNORA_IDENTITY_CACHE_MS` (60 s default), so a ban can lag by that window for cookie sessions; API-key requests are never served from that cache. Open WebSockets re-authenticate every 60 s through the same resolver.
- Deliberately not done: disabling the user's `apikey` rows on ban. Revisit only if a host reads identities without going through `resolveSessionIdentity`.
- Reviewer: check the expiry comparison direction and that an unparseable `banExpires` keeps the ban.
