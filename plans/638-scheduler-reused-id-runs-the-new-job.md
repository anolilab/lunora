# Plan 638: A job scheduled under a reused id runs, instead of being answered from the previous job's result

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/scheduler/src/scheduler-do.ts packages/runtime/src/create-worker.ts packages/do/src/shard-do.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** TODO

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: none
- **Category**: bug
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

`RunOptions.id` lets a caller name a scheduled job. Its doc (`packages/scheduler/src/types.ts` ~133-138) says: "The id is free again once the job has fired or been cancelled", and `handleSchedule` clears the old terminal rows on reuse (a lifecycle test covers reuse). But when the job fires, the dispatch receiver passes the record id to the shard as the mutation id:

```ts
const response = await dispatchToShard(
    candidate.functionPath,
    args,
    shardKey,
    recordId,
    identity,
    request.headers.get("traceparent") ?? undefined,
    scheduledFor,
);
```

and every system dispatch shares one idempotency namespace (`packages/do/src/shard-do.ts` ~5905):

```ts
    protected idempotencyNamespace(): string | undefined {
        const userId = this.currentRequestUserId;

        if (userId !== undefined && userId.length > 0) {
            return userId;
        }

        if (this.currentRequestSystem) {
            return "system:";
        }

        const clientId = this.currentRequestClientId;
```

The shard's idempotency cache is looked up by `(namespace, mutationId)` only and kept 24 h (`IDEMPOTENCY_RETENTION_MS`). So a second job scheduled under an id that already fired within 24 h is answered from the first job's cached result — it never runs, even if it names a different function — and the scheduler records it `succeeded`. For a workflow target the record id is the instance id, and a duplicate-instance error is treated as success (`create-worker.ts` ~3953-3959, ~4323-4329), so the new workflow never starts either. Typical victims: stable per-entity ids such as `sync-user-123` rescheduled after each run.

**Unverified by execution**: the plan author read this path; step 1 proves it with a test.

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

The dedup key must identify one _record_ (one scheduling of the id), stay stable across that record's retries (the at-least-once retry dedup in `dispatch()` and the deferred-schedule outbox in `packages/server/src/deferred-schedules.ts` depend on it), and differ between two schedulings of the same caller id. Give each record a generation discriminator fixed at schedule time (its `enqueuedAt` timestamp if the record already stores one that survives retries; otherwise a counter or random suffix stored on the record) and send `<id>:<generation>` as the mutation id. For workflow targets use the same composite as the instance id only if it still satisfies the engine's instance-id grammar `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$` (use `-` or `_` as the separator there). Records persisted before this change have no generation: fall back to the bare id for them.

## Steps

1. Read `scheduler-do.ts` (`handleSchedule`, `drainRecord`, `dispatch`), the receiver in `create-worker.ts` (~4290-4372, ~3940-3960), and the shard dedup read (`rg -n "readIdempotentResult|dedupedDispatch|idempotencyNamespace" packages/do/src/shard-do.ts`). Decide where the generation lives and say why.
2. Test first. Unit level in `packages/scheduler/__tests__` (the lifecycle test file that already covers id reuse): schedule id `x`, let it fire, schedule `x` again for a different function, and assert the dispatch for the second carries a different dedup key than the first while a _retry_ of one record carries the same key. If an integration harness exists that runs scheduler + shard together (`rg -ln "SchedulerDO" packages/*/__tests__ | head`), add the end-to-end case: the second job's handler actually runs. **Verify**: red at baseline.
3. Implement. 4. Build, test, types, eslint for every touched package (`@lunora/scheduler`, `@lunora/runtime`; `@lunora/do` only if touched).

## Scope

**In scope**: the record shape and dispatch in `packages/scheduler`, the receiver in `packages/runtime/src/create-worker.ts`, tests, the `RunOptions.id` doc if wording needs it. **Out of scope**: changing the shard's idempotency lookup or namespace; cron jobs (they pass no mutation id).

## Git workflow

- Branch: `fix/scheduler-reused-id-dedup`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `fix(scheduler): run a job scheduled under a reused id`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- The dispatch already carries a per-record discriminator and the test in step 2 passes at baseline: report NOT REPRODUCED, commit only the test.
- The generation would have to be added to a wire type exported from a package (api snapshot diff beyond an optional field): STOP and report the shape.

## Maintenance notes

- Reviewer: run `pnpm run test:workerd`. A workflow instance id change means an in-flight job scheduled before the deploy keeps its old id; that is what the fallback is for.
