# Plan 652: Auth admin operations are written to the audit trail, with the real actor

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/auth/src/admin.ts packages/runtime/src/auth-admin-routes.ts packages/auth/src/audit-hooks.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** DONE after one revision (Security feed, via a new `createAuthAuditWriter` wired through codegen), pushed: `security/auth-admin-audit-trail`, PR #1660 (workerd: auth, runtime)

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Revised design after the first execution (2026-11-21)

The first run stopped correctly: no audit sink is reachable from the worker-side admin route. **Owner decision: record admin-plane operations in the Security feed** (the one `authAuditHook` writes and Studio's Security page reads through `authAuditReader`). Decided plumbing:

1. **A writer beside the reader.** `@lunora/auth` exports a writer built from the same executor and table the hook uses — find how `authAuditReader` is constructed and exported and add `authAuditWriter` the same way (same module, same naming, same entry shape and column mapping as the rows `authAuditHook` inserts; reuse its insert function, do not write a second SQL statement). Update `api-snapshots/auth.api.md` by hand.
2. **Wiring.** The runtime receives it the way it receives `authAuditReader`: an optional `WorkerOptions` field, emitted by codegen in `packages/codegen/src/emit/app-worker-options.ts` wherever the reader is emitted (same condition, same env binding). Regenerate golden fixtures and example `_generated/` output with the package's own scripts (`rg -n "golden|fixture|codegen" packages/codegen/package.json package.json | head`), never by hand; update `api-snapshots/runtime.api.md` for the new optional option. Where the reader is absent (DO-mode auth, no auth) the writer is absent and the route records nothing, as today.
3. **Recording.** In `packages/runtime/src/auth-admin-routes.ts`, after a **mutating** method succeeds, write one entry: operation, target id (user / organization / key id — never the request body, passwords, tokens or key material), actor (`admin:root` or `admin:<tokenName>`; the route's deps already know the named token — pass its name in, never its value), time. Reads write nothing. A failed write is logged and does not fail the operation (mirror the hook's policy). Give the entries an event type Studio's feed can show; check how the Security page renders an unknown type (`rg -n "authAudit|eventType|action" packages/studio/src/features/auth --glob '*.ts*' | head -30`) and add labels for the new ones in the same table the existing labels live in.
4. **Impersonation actor.** Pass `impersonatedBy: "admin:<tokenName>" | "admin:root"` from the route when it starts an impersonation, so later actions in that session are attributed to the admin (`resolveActor` accepts any non-empty string). First check better-auth 1.7.16's stop-impersonating path and anything else that reads `impersonatedBy` as a user id; if one does, leave the field alone and rely on the audit entry, and say so.
5. **Platform targets.** This adds a host-backed write on the D1 auth executor only; state in the commit body that the Node target is covered iff the reader already is there (check `packages/platform-node` for `authAuditReader`) and do the same wiring there if so.

Tests: the list in Steps still applies; add one that a deployment without the writer still serves every admin route. New branch `security/auth-admin-audit-trail` from `origin/alpha`, commit `security(auth): audit admin-plane operations`. STOP only if the hook's insert cannot be reused outside a better-auth request context — then report what it depends on.

## Why this matters

The auth audit trail is fed by better-auth's `hooks.after` (`packages/auth/src/audit-hooks.ts`, `authAuditHook`), which sees better-auth's own HTTP endpoints. Lunora's admin plane (`packages/auth/src/admin.ts`, served by `packages/runtime/src/auth-admin-routes.ts`) calls better-auth's `internalAdapter` directly ("deliberately bypassing the plugins' own endpoints", ~785-791), so none of its operations are audited: impersonate, set password, set role, create/remove/ban user, membership and organization changes, disable two-factor, unlink account, API-key revoke. The route handler (~775-820) authorizes, runs the method and returns. An operator or a leaked admin token can mint a session for any user or reset a password with no trace in Studio's security feed. Impersonation is worse: `admin.ts` (~1310-1314) defaults `impersonatedBy` to the user's own id, so what is done with that session is recorded as the user acting on themselves, although the worker knows which admin token made the call (`create-worker.ts` ~3528, `adminGrants … tokenName`).

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

Record one audit entry per **mutating** auth admin operation, at the single choke point: the route handler in `auth-admin-routes.ts`, after the method succeeds (and one for a failed attempt only if the hook-fed trail records failures for the equivalent endpoint — match it). Reuse the existing writer and entry shape: find how `authAuditHook` persists an entry and how `recordImportAudit(headers)` (`create-worker.ts` ~4610) records an admin op, and write through the same sink with: the operation name, the target (user / organization id — never passwords, tokens, key material or the request body), the actor (`root` or the named token's **name**, never its value), and time. Reads are not audited. An audit write failure must not fail the admin operation (log it), matching the hook's policy — check what the hook does and mirror it.

For impersonation: pass the acting admin through so the session's `impersonatedBy` identifies the admin token (a stable marker such as `admin:<tokenName>` / `admin:root`) instead of the user's own id, **if** `resolveActor` (`audit-hooks.ts` ~463-469) and anything else reading `impersonatedBy` can carry a non-user-id value; if they require a user id, leave the field alone and rely on the new audit entry, and say so.

## Steps

1. Read the sink(s) and decide which one admin-plane entries belong in (the auth audit feed Studio shows — confirm with `rg -n "audit" packages/studio/src --glob '*.ts*' -l | head`). Write down the entry shape you will emit and an existing entry it matches.
2. Tests first in `packages/runtime/__tests__/auth-admin.test.ts`: each mutating method class (user lifecycle, role, password, impersonate, membership/org, two-factor, api key) produces one entry with operation, target and actor; a read produces none; a named token's entry carries its name; no entry contains the password or token from the request. Red at baseline.
3. Implement. 4. Docs: the audit page lists what is recorded (`rg -n -i "audit" apps/docs/src/content/docs -l | head`) — add the admin plane. 5. Build, test, types, eslint for `@lunora/auth` and `@lunora/runtime`.

## Git workflow

- Branch: `security/auth-admin-plane-gaps (same branch as plan 651, separate commit)`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `security(auth): audit admin-plane operations`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- There is no sink reachable from the worker-side route (the trail can only be written from inside a better-auth request or a shard): STOP and report what plumbing would be needed.
- Adding the actor needs a public type change beyond an optional field: STOP and report it.
