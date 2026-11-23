# Plan 645: A write the outbox failed to store is rolled back and reported, not shown as saved

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/db/src/internals.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** DONE, pushed: `fix/db-outbox-replay-integrity`, PR #1654

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

`@lunora/db` gives the client a durable outbox built on `@tanstack/offline-transactions` (pinned in `pnpm-workspace.yaml`; read the installed version in `node_modules` when the plan refers to its behaviour — it is read-only). The client hands a write to the outbox "sink" (`packages/db/src/internals.ts` ~283-301, `enqueue`), and the outbox replays it later through `packages/db/src/define-collections.ts` (~495-600), which calls `client.mutation(..., { mutationId, replayBaseline, replayCredential, shardKey })`.

The sink's `enqueue` resolves as soon as it has _asked_ the executor to commit, and swallows every failure:

```ts
            // Commit explicitly (not via `autoCommit`, whose upstream failure
            // handler rethrows inside its own .catch — every terminal verdict
            // would surface as an unhandled rejection) and swallow the outcome:
            // retries are the executor's job and permanent drops are reported
            // through the replay handler / `onWriteRejected`, not this promise.
            transaction.commit?.().catch(() => undefined);

            return Promise.resolve();
        },
    };
```

The comment's reasoning ("permanent drops are reported through the replay handler") does not hold for a write that was never **stored**: if persisting the transaction throws (storage quota at write time), the write never reaches the replay handler. The client has already confirmed the optimistic value, nothing retries, and neither `onWriteRejected` nor `onStorageFailure` fires (the latter only runs at the startup probe). The user sees a saved value that exists nowhere.

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

## Design (decided)

Tell a _persist_ failure apart from the outcomes the comment legitimately swallows. Read the installed `@tanstack/offline-transactions` (`api/OfflineTransaction`, `OfflineExecutor`) to find how a persist failure surfaces from `commit()` versus a failed/terminal `mutationFn` run. On a persist failure: run the write's recorded rollback (the entry in `outboxRejections` for this key — see how the replay handler takes and runs it) and report through the same channel a terminal rejection uses (`onWriteRejected`), with a reason that says the write could not be stored; remove the `outboxRejections` entry so it does not leak. All other commit outcomes stay swallowed as today. If the two cannot be told apart from the error alone, wrap the storage adapter the executor is given (the sink constructs it) so a failed `add`/`set` is observed directly.

## Steps

1. Tests first in `packages/db/__tests__`: a storage adapter whose write throws → the optimistic value is rolled back, `onWriteRejected` fires once with the storage reason, `outboxRejections` holds no entry for the key; a normal enqueue and a normal terminal rejection behave exactly as before. Red at baseline.
2. Implement; rewrite the comment to state the distinction. 3. Docs: if `onWriteRejected`'s docs enumerate reasons, add this one. 4. Build, test, types, eslint for `@lunora/db`.

## Git workflow

- Branch: `fix/db-outbox-replay-integrity (same branch as plans 643-644, separate commit)`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `fix(db): report a write the outbox could not store`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- A persist failure cannot be observed without patching the dependency: STOP and report what hook is missing.
