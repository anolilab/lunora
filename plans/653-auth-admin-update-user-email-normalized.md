# Plan 653: `AuthAdmin.updateUser` normalizes an email change and refuses a taken address

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/auth/src/admin.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** TODO

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

better-auth looks users up by lower-cased email. The admin plane's `createUser` lower-cases the address and refuses an existing one:

```ts
        createUser: ({ data, email, name, password, role }) =>
            withContext(async (context_) => {
                const normalizedEmail = email.toLowerCase();

                if (await context_.internalAdapter.findUserByEmail(normalizedEmail)) {
                    throw new LunoraAuthAdminError("a user with this email already exists", "USER_ALREADY_EXISTS");
                }
```

`updateUser` writes whatever it is given:

```ts
        updateUser: ({ data, userId }) =>
            withContext(async (context_) => {
                const user = await context_.internalAdapter.updateUser(userId, data);

                return toUser(user as Record<string, unknown>);
            }),
    };
};
```

Editing a user's address to `Alice@Example.com` in Studio leaves the account unable to sign in by email or reset its password, and a mixed-case address can sit beside an existing lower-case one. better-auth's own `/admin/update-user` lower-cases and refuses a taken address.

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

| Purpose                       | Command                                                         | Expected on success |
| ----------------------------- | --------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/auth..." run build`                     | exit 0              |
| One test file                 | `pnpm --filter "@lunora/auth" exec vitest run __tests__/<file>` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/auth" run test`                         | all pass            |
| Types                         | `pnpm --filter "@lunora/auth" run lint:types`                   | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/auth" run lint:eslint`                  | exit 0, 0 warnings  |

## Design (decided)

In `updateUser`, when `data.email` is a string: lower-case (and trim, if `createUser`'s callers trim) it; if another user (`id !== userId`) already has that address, throw the same `LunoraAuthAdminError(..., "USER_ALREADY_EXISTS")` `createUser` throws; write the normalized value. Setting the user's own current address (any casing) is not a conflict. Check how that error code maps to an HTTP status in `packages/runtime/src/auth-admin-routes.ts` and that the mapping covers this route. If the repo's email gate (`packages/auth/src/email-gate.ts`) should also run on an admin-made address change the way it runs on a user-made one, say what it does today and leave it unchanged.

## Steps

1. Tests first in the admin behaviour tests (`rg -ln "updateUser" packages/auth/__tests__`): mixed-case input is stored lower-case and the user can be found by it; another user's address (any casing) → `USER_ALREADY_EXISTS`, nothing written; same user, different casing → succeeds; an update without `email` is unchanged. Red at baseline. 2. Implement. 3. Build, test, types, eslint for `@lunora/auth`.

## Git workflow

- Branch: `security/auth-admin-plane-gaps (same branch as plans 651-652, separate commit)`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `fix(auth): normalize an admin email change`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- An existing test stores a mixed-case email through `updateUser` on purpose: STOP and report it.
