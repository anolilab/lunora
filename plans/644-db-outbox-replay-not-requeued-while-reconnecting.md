# Plan 644: A durable replay that finds the socket down fails transiently instead of being queued again as a new write

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/client/src/lunora-client.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** TODO

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MEDIUM
- **Depends on**: none
- **Category**: bug
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

`@lunora/db` gives the client a durable outbox built on `@tanstack/offline-transactions` (pinned in `pnpm-workspace.yaml`; read the installed version in `node_modules` when the plan refers to its behaviour — it is read-only). The client hands a write to the outbox "sink" (`packages/db/src/internals.ts` ~283-301, `enqueue`), and the outbox replays it later through `packages/db/src/define-collections.ts` (~495-600), which calls `client.mutation(..., { mutationId, replayBaseline, replayCredential, shardKey })`.

When `client.mutation` is called while the connection is down or reconnecting, it queues the write. A replay coming _from_ the durable outbox must not be queued again — the code says so and guards one of three conditions:

```ts
// The durable path's OWN replay is the exception: it re-enters here
// carrying `replayBaseline` (every durable replay pins one), is already
// persisted, and re-queueing it would loop it back into the queue it is
// draining. A caller-supplied `mutationId` alone is not a replay:
// `importRows` and app code pass one for idempotency, and those writes
// must still go behind the queue.
//
// With a durable outbox this is process-wide, not per shard: the sink
// reports only its total depth. Over-inclusion costs a write a trip
// through the outbox, under its own `mutationId`, which is safe.
// An online-only write is never queued behind the backlog: it goes out now.
const queuedAhead = !options.onlineOnly && shouldQueueOffline && options.replayBaseline === undefined && this.hasPendingWriteAhead(options.shardKey);
```

```ts
if (socketDown || midReconnect || queuedAhead) {
    return enqueue();
}
```

`queuedAhead` excludes replays (`options.replayBaseline === undefined`); `socketDown` and `midReconnect` do not. The outbox executor retries constantly (its online detector always reports online, `packages/db/src/internals.ts` ~489-515), so a replay attempted while offline goes back into the sink, resolves `{ committed: false }`, and the executor sees its original transaction succeed while a _new_ outbox entry is persisted behind newer writes. Effects: the collection transaction completes while the device is still offline (the optimistic row can be dropped), FIFO order is broken, the rollback handle is lost, and a later rejection is reported without its row.

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

| Purpose                       | Command                                                           | Expected on success |
| ----------------------------- | ----------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                  | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/client..." run build`                     | exit 0              |
| One test file                 | `pnpm --filter "@lunora/client" exec vitest run __tests__/<file>` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/client" run test`                         | all pass            |
| Types                         | `pnpm --filter "@lunora/client" run lint:types`                   | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/client" run lint:eslint`                  | exit 0, 0 warnings  |

## Design (decided)

A call carrying `replayBaseline` (a durable replay) that meets `socketDown` or `midReconnect` must **throw a transient error** instead of enqueueing, so the outbox keeps the original entry and retries it. Use the error the client already throws for "not sent, safe to retry" (look at what the outbox-path catch block ~4679-4686 and `terminalVerdict` in `packages/db/src/define-collections.ts` treat as transient — the thrown error must classify as transient there, not as a terminal rejection). Undo any optimistic layers the call applied before throwing, the way the online-only refusal just above does (`refuseOnlineOnlyWhenDown` / `optimisticRollbacks`). The built-in `OfflineQueue`'s own replay path must keep working: check whether it also passes `replayBaseline` and how it expects a down socket to be handled; if it relies on the current behaviour, scope the change to replays that come from the durable outbox and say how you tell them apart.

## Steps

1. Tests first in `packages/client/__tests__` (and `packages/db/__tests__/outbox-replay.test.ts` if its harness can take the socket down): a `client.mutation` with `replayBaseline` while the socket is down rejects with the transient error and the outbox sink's `enqueue` is **not** called; the same call without `replayBaseline` still enqueues; with the db harness, the entry is still in the outbox, in its original position, after a failed offline replay and commits once after reconnect. Red at baseline.
2. Implement; update the comment block so all three conditions are covered. 3. Build, test, types, eslint for `@lunora/client` and `@lunora/db`.

## Git workflow

- Branch: `fix/db-outbox-replay-integrity (same branch as plan 643, separate commit)`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `fix(client): keep a durable replay out of the queue it drains`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- The executor treats the thrown error as terminal and drops the entry (data loss): STOP — do not ship; report what it classifies as transient.
