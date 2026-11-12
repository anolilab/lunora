# Plan 543 — Give composed calls inside a scheduled job the virtual clock

> **Executor instructions.** Follow this plan step by step. Run every `Verify:` command and confirm
> the expected result before moving on. If anything in §8 (STOP conditions) happens, stop and
> report; do not improvise. Do not edit `plans/README.md`: the reviewer maintains it.
>
> **Drift check (run first):**
> `git diff --stat 4a7c48bfd..HEAD -- packages/testing/src/harness.ts packages/testing/src/fake-scheduler.ts packages/testing/__tests__/scheduler.test.ts`
> must print nothing. Then confirm the excerpts in §1 match. Any mismatch is a STOP.

**Baseline:** `4a7c48bfd` (2026-11-11)
**Status:** DONE (review APPROVED; branch `fix/improve-543-scheduled-job-clock`, commit `5e8333fc2`; merge before 542; not merged)
**Priority / effort / risk:** P2 / S / LOW. **Category:** tests (harness fidelity). **Depends on:** none.
**Merge order:** before plan 542 (both edit the dispatch block of `harness.ts`).

## 0. Headline finding

In `lunoraTest`, a scheduled job fired by `t.scheduler.advance(ms)` sees the advanced virtual time as
`ctx.now`, but any `ctx.runQuery` / `ctx.runMutation` it composes reads the harness's construction
clock instead. Production reads one clock per execution, so a TTL check written in a helper query
passes in production and fails (or the reverse) in the harness.

## 1. Current state (audit)

- `packages/testing/src/fake-scheduler.ts:332-339` (inside the job runner):

    ```ts
    const dispatch = getDispatch();
    const context = entry.kind === "action" ? getActionContext() : getMutationContext();

    // `ctx.now` is the VIRTUAL clock at fire time, not the harness's construction
    // instant: production dispatches the job as its own RPC and captures `Date.now()`
    // then, so a TTL handler that woke after `advance(3_600_000)` must see an hour
    // of elapsed time rather than zero.
    await dispatch(entry.kind, entry, { ...(context as Record<string, unknown>), now: nowMs }, job.args);
    ```

    The spread makes a copy whose `now` is fixed, but the copy's `runQuery` / `runMutation` closures
    still dispatch on the BASE contexts.

- `packages/testing/src/fake-scheduler.ts:120` — `type ScheduledDispatch = (kind: "action" | "mutation", reference: unknown, context: unknown, args: unknown) => Promise<unknown>;`
  and `:146` `getDispatch: () => ScheduledDispatch`.
- `packages/testing/src/harness.ts`:
    - `:399` `const runClock = new AsyncLocalStorage<number>();` — "The clock the current top-level harness call reads through `ctx.now`".
    - `:714-715` `inRun` wraps each top-level call in `runClock.run(currentNow(), …)`.
    - `:780-782`, `:808-810`, `:868-870` — every context's getter: `get now(): number { return runClock.getStore() ?? currentNow(); }`.
    - `:819-825` `mutationContext.runMutation` / `runQuery` call `runInternal(..., mutationContext/queryContext, ...)` (the base contexts).
    - `:926-932` the scheduled dispatch, NOT wrapped in `runClock`:

        ```ts
        scheduledDispatchRef ??= (kind, reference, context, args) => {
            if (kind === "mutation") {
                return runInTransaction(() => runRegisteredFunction("mutation", reference as never, context, args, true)).then(notifyAfter);
            }

            return runWithBudget(() => runInternal("action", reference, context, args));
        };
        ```

- Test pattern: `packages/testing/__tests__/scheduler.test.ts`, test "gives a scheduled job the
  advanced clock as ctx.now" (~lines 840-853): `lunoraTest(schema, { functions, now: 1_000_000 })`,
  `t.run(async (ctx) => ctx.scheduler.runAfter(0, "log:recordNow", {}))`, `t.scheduler.advance(3_600_000)`,
  then reads the `log` table. Functions are declared at the top of the file with
  `initLunora.dataModel().create()` and registered in the `functions` map (~line 147).

## 2. Existing seams (do not reinvent)

- `runClock` is exactly the mechanism: running the scheduled dispatch inside
  `runClock.run(nowMs, …)` makes every context's `now` getter (and every composed call, which inherits
  the async context) read the fire time.

## 3. The behavioural contract to preserve

- The existing test "gives a scheduled job the advanced clock as ctx.now" keeps passing.
- Scheduled mutations still run in their own transaction and notify listeners; actions still run
  under their own budget.

## 4. Design decisions

- Pass the fire time to the dispatch: change `ScheduledDispatch` to
  `(kind, reference, context, args, nowMs: number) => Promise<unknown>`; the harness wraps both
  branches in `runClock.run(nowMs, () => …)`. `fake-scheduler.ts` passes the base `context` unchanged
  (no spread): the spread evaluated the `now` getter once and is no longer needed.
  Chosen over reading `(context as { now }).now` inside the harness (couples to the spread) and over
  importing `runClock` into the fake scheduler (it is private to `harness.ts`).

## 5. Workstream — steps

**Commands you will need** (run from the worktree root):

| Purpose             | Command                                                                                                                               | Expected |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Install             | `pnpm install`                                                                                                                        | exit 0   |
| Build deps          | `pnpm --filter "@lunora/testing..." run build`                                                                                        | exit 0   |
| One test file       | `pnpm --filter "@lunora/testing" exec vitest run __tests__/scheduler.test.ts`                                                         | all pass |
| Package tests       | `pnpm --filter "@lunora/testing" run test`                                                                                            | all pass |
| Types               | `pnpm --filter "@lunora/testing" run lint:types`                                                                                      | exit 0   |
| Format              | `pnpm exec oxfmt packages/testing/src/harness.ts packages/testing/src/fake-scheduler.ts packages/testing/__tests__/scheduler.test.ts` | exit 0   |
| Lint (after format) | `pnpm --filter "@lunora/testing" run lint:eslint`                                                                                     | exit 0   |

**Scope.** In scope: `packages/testing/src/harness.ts` (the `scheduledDispatchRef` block only),
`packages/testing/src/fake-scheduler.ts` (the `ScheduledDispatch` type and the one dispatch call),
`packages/testing/__tests__/scheduler.test.ts`. Out of scope: every other harness behaviour, the
wire round-trip of results (plan 542), the real `@lunora/scheduler`.

**Step 1 — install and build.** Verify: exit 0.

**Step 2 — failing test.** In `scheduler.test.ts`:

- add a query `readNow = internalQuery.query(({ ctx }) => ctx.now)` (add `internalQuery` to the
  destructured `initLunora…create()` call if it is not there; if the builder API differs, copy the
  shape of an existing query in this file);
- add an internal mutation `recordComposedNow` that does
  `const seen = await ctx.runQuery(readNow, {}); await ctx.db.insert("log", { message: \`composed:${String(seen)}\` });`(if`ctx.runQuery`takes a function path string in this harness rather than a reference, use the
form the existing tests or`harness.ts:791-793`accept, and register`readNow`in`functions`as`"log:readNow"`);
- register both in `functions`;
- test "gives a composed query inside a scheduled job the advanced clock": copy the existing
  "gives a scheduled job the advanced clock as ctx.now" test, schedule `log:recordComposedNow`, advance
  `3_600_000`, and expect a log row `composed:${String(1_000_000 + 3_600_000)}`.

Verify: one-test-file command → the new test FAILS (it records `composed:1000000`).

**Step 3 — the fix.** In `fake-scheduler.ts`, change `ScheduledDispatch` to take a fifth parameter
`nowMs: number` and call `await dispatch(entry.kind, entry, context, job.args, nowMs);` (drop the
spread; keep the comment but make it say the fire time is passed so the harness can run the whole job,
composed calls included, under that clock). In `harness.ts`, make `scheduledDispatchRef` accept
`nowMs` and wrap each branch's body in `runClock.run(nowMs, () => …)`.
Verify: one-test-file command → all pass.

**Step 4 — red without the fix (mandatory).** Commit (Step 6), then
`git diff 4a7c48bfd..HEAD -- packages/testing/src/harness.ts packages/testing/src/fake-scheduler.ts | git apply -R`,
run the one-test-file command, confirm the new test fails, restore with
`git checkout -- packages/testing/src/harness.ts packages/testing/src/fake-scheduler.ts`, confirm
`git status --short` is clean.

**Step 5 — gates.** Format, lint, types, package tests. Verify: all exit 0.

**Step 6 — commit.** Stage the three files by path. Message:

```
fix(testing): run a scheduled job's composed calls on the virtual clock

A job fired by scheduler.advance saw the fire time as ctx.now, but a
ctx.runQuery or ctx.runMutation it composed read the harness's start clock.
The whole job now runs under the fire time.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

## 6. Platform parity

Not applicable: test harness only.

## 7. Phasing & ordering

| Phase | Work      | Gate                                                           |
| ----- | --------- | -------------------------------------------------------------- |
| 0     | Steps 1-6 | new test red without the fix; testing tests, types, lint green |

## 8. Risks & STOP conditions

- **STOP** on drift or excerpt mismatch.
- **STOP** if `ScheduledDispatch` / `getDispatch` is used by any file other than `harness.ts` and
  `fake-scheduler.ts` (`grep -rn "ScheduledDispatch\|getDispatch" packages/testing/src`).
- **STOP** if any existing testing test fails after Step 3.
- **STOP** after two failed attempts at any one verification.

## 9. Open questions

None.

## Done criteria (all must hold)

- [ ] `git diff --stat 4a7c48bfd..HEAD` lists only the three in-scope files.
- [ ] `grep -n "now: nowMs" packages/testing/src/fake-scheduler.ts` prints nothing.
- [ ] New test passes and failed with the fix reverted (Step 4).
- [ ] `pnpm --filter "@lunora/testing" run test`, `run lint:types`, `run lint:eslint` exit 0.
- [ ] One commit with the message above.
