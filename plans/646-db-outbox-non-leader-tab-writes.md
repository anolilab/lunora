# Plan 646: An offline write made in a non-leader tab, or before leader election finishes, is not silently lost (investigate, then fix)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/db/src/internals.ts packages/db/src/define-collections.ts packages/client/src/lunora-client.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** DONE, pushed: `fix/db-outbox-replay-integrity`, PR #1654

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: run after plans 643-645 (same files)
- **Category**: bug
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

`@lunora/db` gives the client a durable outbox built on `@tanstack/offline-transactions` (pinned in `pnpm-workspace.yaml`; read the installed version in `node_modules` when the plan refers to its behaviour — it is read-only). The client hands a write to the outbox "sink" (`packages/db/src/internals.ts` ~283-301, `enqueue`), and the outbox replays it later through `packages/db/src/define-collections.ts` (~495-600), which calls `client.mutation(..., { mutationId, replayBaseline, replayCredential, shardKey })`.

Suspected data loss, **established by reading only**: `@tanstack/offline-transactions`' executor is "offline enabled" only in the leader tab, and only after an async storage probe and leader election (the repo's own test notes the BroadcastChannel fallback election takes ~10 s). When it is not enabled, `createOfflineTransaction` returns a plain transaction that runs the mutation function **once**, with no storage and no retry. The sink (`internals.ts` ~283-301) cannot tell: it commits, swallows the outcome and resolves, so the client confirms the optimistic value and returns `{ committed: false }`. Offline, that single attempt fails with a transient error, which `terminalVerdict` (`define-collections.ts` ~569-593) does not treat as a rejection, so no rollback and no `onWriteRejected`. A write made offline in a second tab, or in the first seconds after load, would vanish while the UI keeps showing it. `apps/docs/src/content/docs/concepts/offline-first.mdx` (~179-181) recommends `@lunora/db` because its outbox "is fully leader-coordinated".

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

| Purpose                       | Command                                                       | Expected on success |
| ----------------------------- | ------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                              | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/db..." run build`                     | exit 0              |
| One test file                 | `pnpm --filter "@lunora/db" exec vitest run __tests__/<file>` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/db" run test`                         | all pass            |
| Types                         | `pnpm --filter "@lunora/db" run lint:types`                   | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/db" run lint:eslint`                  | exit 0, 0 warnings  |

## Steps

1. Read the installed executor (`OfflineExecutor`: `isOfflineEnabled`, `createOfflineTransaction`, leadership) and confirm or refute the description above with file:line.
2. Reproduce in `packages/db/__tests__` using the stand-ins `outbox-replay.test.ts` already has for Web Locks/localStorage: (a) a follower (leadership held elsewhere) and (b) a client before election completes each make a write while the transport is down. Assert what the product should guarantee: the write is either durably queued and later committed, or rolled back and reported — never confirmed-and-lost. If both already hold: keep the tests, report NOT REPRODUCED.
3. Fix, in this order of preference, taking the first that works without patching the dependency:
   a. While the executor is not offline-enabled, the sink reports "cannot take this write" and the client falls back to its built-in `OfflineQueue` for it (the client already has that queue; find how it chooses between `this.outbox` and the built-in queue, ~4840-4900). Before election completes, hold the write until the executor reports its leadership state, then route it.
   b. If (a) cannot be done cleanly: in a non-enabled executor, make a transient failure of the single attempt a reported rejection (rollback + `onWriteRejected`), so the write is at least never shown as saved.
   Say which you chose and what the follower-tab guarantee now is; update `offline-first.mdx` to state it exactly.
4. Build, test, types, eslint for `@lunora/db` and `@lunora/client`.

## Git workflow

- Branch: `fix/db-outbox-replay-integrity (same branch as plans 643-645, separate commit)`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `fix(db): keep a follower tab from losing an offline write`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- Neither (a) nor (b) is possible without a change in `@tanstack/offline-transactions`: STOP with the tests and a write-up of what the dependency would need.
- (a) would let the same write be sent by both the built-in queue and the outbox: STOP and report.
