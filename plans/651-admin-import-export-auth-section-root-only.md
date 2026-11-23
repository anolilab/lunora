# Plan 651: Importing or exporting the auth tables needs the root admin token

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/runtime/src/data-movement-admin-routes.ts packages/runtime/src/create-worker.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** TODO

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

Lunora has a root admin token and _named_ admin tokens (handed to CI, operators). The documented rule (`apps/docs/src/content/docs/production-checklist.mdx` ~94-100; `packages/runtime/src/auth-admin-routes.ts` ~215-241) is that a named token may read, and may write only what takes authority away; anything that outlives the token's revocation needs the root token. The auth admin routes enforce it:

```ts
deps.assertAdmin(request);

if (!NAMED_TOKEN_AUTH_METHODS.has(descriptor.method)) {
    deps.assertRootAdmin(request);
}
```

and the auth jurisdiction move is wired with `assertAdmin: assertRootAdmin` (`create-worker.ts` ~4389). The data-movement routes are not:

```ts
    const dataMovementAdminRoutes = buildDataMovementAdminRoutes({
        applyGlobals: options.applyGlobals,
        assertAdmin: assertAdminAuthorized,
        exportCursorStore: options.exportCursorStore,
        exportSinks: options.exportSinks,
        defaultShardKey: defaultShard,
        // Codegen supplies the schema's table list, so "every table" is a real list
        // rather than an empty one. It used to be hardcoded empty with a note that
```

`/_lunora/admin/export` with `sections: ["auth"]` streams the auth tables (only OAuth tokens are redacted — `LIVE_CREDENTIAL_COLUMNS` in `packages/auth/src/data-port.ts`), so a named token can take password hashes, two-factor secrets and backup codes. `/_lunora/admin/import` (and its staged commit) writes `$auth` lines through `authData.importRows`, so a named token can add a user with an admin role and a credential it chose, an owner membership, or an API key — grants that survive the token's revocation — and a replace commit can rewrite or wipe the user base.

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

| Purpose                       | Command                                                            | Expected on success |
| ----------------------------- | ------------------------------------------------------------------ | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                   | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/runtime..." run build`                     | exit 0              |
| One test file                 | `pnpm --filter "@lunora/runtime" exec vitest run __tests__/<file>` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/runtime" run test`                         | all pass            |
| Types                         | `pnpm --filter "@lunora/runtime" run lint:types`                   | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/runtime" run lint:eslint`                  | exit 0, 0 warnings  |

## Design (decided)

Pass `assertRootAdmin` into `buildDataMovementAdminRoutes` beside `assertAdmin` (other route builders already take both, e.g. ~4725-4726) and call it, after `assertAdmin`, on exactly these paths: an **export** whose resolved sections include `auth`; an **import** (streaming, staged upload, and staged **commit**) whose payload carries an auth section / `$auth` rows. For import the section is only known from the body: reject as early as the route can know it (the request's declared sections if the API has them; otherwise at the first `$auth` line, before any auth row is written and — for a replace — before anything is cleared). A named token's export or import without the auth section keeps working. The error is the same 403 the other root-only routes give.

## Steps

1. Read the three import entry points and where the auth section is first identified (`rg -n "auth" packages/runtime/src/data-movement-admin-routes.ts packages/runtime/src/import-stream.ts packages/runtime/src/import-session*.ts packages/runtime/src/export-sections.ts | head -60`). State for each path the earliest point the route knows auth rows are involved.
2. Tests first in `packages/runtime/__tests__/named-admin-tokens.test.ts` (it has the named-token fixtures) or `admin-export-import.test.ts`: named token + export with `sections: ["auth"]` → 403; named token + import with `$auth` rows (each entry point, incl. staged commit) → 403 and **no** auth row written and nothing cleared; named token without the auth section → still works; root token → works as before. Red at baseline.
3. Implement. 4. Docs: add import/export of the auth section to the root-only list in `production-checklist.mdx` and wherever named-token scope is listed (`rg -n -i "named token" apps/docs packages/*/docs | head`). 5. Build, test, types, eslint for `@lunora/runtime`.

## Git workflow

- Branch: `security/auth-admin-plane-gaps`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `security(runtime): require the root token to move auth tables`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- On a streaming import the auth rows can only be detected after earlier, non-auth sections were already committed: still refuse at that point, and report exactly what a refused named-token import leaves behind.
- A documented named-token use case is "full backup including auth" (`rg -n -i "backup" apps/docs | head`): STOP and report the doc.
