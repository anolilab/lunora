# Plan 639: A workpool slot stays held while the first attempt of a job is still running

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/scheduler/src/scheduler-do.ts packages/runtime/src/create-worker.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** TODO

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: MEDIUM
- **Depends on**: none
- **Category**: bug
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Revised design after the first execution (2026-11-21)

The first run stopped correctly: simply not releasing on `in-progress` leaves a slot with no release path in two outcomes. Decided design — do all three parts together, in this order, each with its own test:

1. **A record that already holds a slot may re-enter.** In `reservePoolSlot`, check whether the record already holds a slot _before_ the `inFlight >= maxConcurrency` check; if it does, admit it without taking another slot. This removes the wedge where every slot is held by declined jobs and each one's own re-fire is backpressured forever (today reachable at `maxConcurrency: 1`).
2. **`/cancel` releases a pooled record's slot.** When `/cancel` removes a record that holds a pool slot, release that slot by id under the pool lock (idempotent, like the other releases). This closes "cancel lands after a decline, receiver cut off".
3. **Then** stop releasing on `in-progress` on both sides (the scheduler's `drainRecord` and the receiver in `packages/runtime/src/create-worker.ts`), as the original Design said. The Node dispatch route rejects pool targets, so it needs no change — confirm and say so.

After the change, restate the table "what releases the slot in each outcome" from your first report and show that no row says "nothing". If a row still does, STOP again with that row. Commit on a NEW branch `fix/scheduler-pool-slot-in-progress` cut from `origin/alpha` (the earlier branch is already in review), message `fix(scheduler): keep the pool slot of a still-running attempt`.

## Why this matters

A workpool job holds a concurrency slot until it settles. When a job re-fires while its first attempt is still running (a Durable Object eviction plus the dispatch lease lapsing), the shard answers `409 DISPATCH_IN_PROGRESS`. Both sides then free the slot although the first attempt still runs: `drainRecord` treats every non-`true` outcome as "the kick failed" —

```ts
const outcome = await this.dispatch(record);
        const ok = outcome === true;
        const poolName = record.pool;

        if (!ok && poolName !== undefined) {
            // The kick itself failed: no completion callback is coming, so free
            // the reserved slot immediately. recordRetry() then re-arms the job.

```

— and the receiver in `packages/runtime/src/create-worker.ts` (~4365-4370) calls `releasePoolSlot(candidate)` whatever the shard answered. Other pooled jobs take the slot, so `maxConcurrency` (when > 1) is exceeded until the first attempt finishes. Narrow trigger, real cap violation.

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

| Purpose                       | Command                                                              | Expected on success |
| ----------------------------- | -------------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                     | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/scheduler..." run build`                     | exit 0              |
| One test file                 | `pnpm --filter "@lunora/scheduler" exec vitest run __tests__/<file>` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/scheduler" run test`                         | all pass            |
| Types                         | `pnpm --filter "@lunora/scheduler" run lint:types`                   | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/scheduler" run lint:eslint`                  | exit 0, 0 warnings  |

## Design (decided)

An `"in-progress"` outcome means a completion is still coming: do not release the slot on it, on either side. Keep releasing on a genuine failure. Read `dispatch()` to see the exact outcome values and how the receiver can tell a 409 in-progress response from other responses (status + code). Read the doc comment of `releasePoolSlot` about slot leaks first: the change must not create a path where a slot is never released — the first attempt's own completion still releases it; say in your report what releases the slot in each outcome.

## Steps

1. Tests first in the scheduler's pool tests (`rg -ln "releaseSlot|maxConcurrency" packages/scheduler/__tests__`): pool with `maxConcurrency: 2`, job A dispatched and still running, A re-fires and gets in-progress → the pool still counts A's slot; a real dispatch failure still frees it. Same for the receiver side if it has a test seam (`rg -ln "releasePoolSlot" packages/runtime/__tests__`). Red at baseline.
2. Implement both sides. 3. Build, test, types, eslint for `@lunora/scheduler` and `@lunora/runtime`.

## Git workflow

- Branch: `fix/scheduler-reused-id-dedup (same branch as plan 638, separate commit)`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `fix(scheduler): keep the pool slot of a still-running attempt`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- Not releasing on in-progress leaves a slot with no remaining release path in some outcome (for example the first attempt died without completing): STOP and report that outcome instead of trading a cap violation for a leak.
