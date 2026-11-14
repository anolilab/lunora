# Plan 537 — Keep the last trusted pause state when a later pause-flag read fails

> **Executor instructions.** Follow this plan step by step. Run every `Verify:` command and confirm
> the expected result before moving on. If anything in §8 (STOP conditions) happens, stop and
> report; do not improvise. Do not edit `plans/README.md`: the reviewer maintains it.
>
> **Drift check (run first):** `git diff --stat 4a7c48bfd..HEAD -- packages/runtime/src/deployment-pause.ts packages/runtime/__tests__/deployment-pause.test.ts`
> must print nothing. Then confirm the excerpts in §1 match the live file. Any mismatch is a STOP.

**Baseline:** `4a7c48bfd` (2026-11-11)
**Status:** DONE (review APPROVED; branch `fix/improve-537-pause-read-failure`, commit `c9cee5101`; not merged)
**Priority / effort / risk:** P2 / S / LOW. **Category:** bug. **Depends on:** none.

## 0. Headline finding

A Worker isolate that has seen the deployment as **paused** starts serving function calls again as
soon as one later read of the pause flag fails (the scheduler Durable Object is briefly unreachable).
The failure branch caches "not paused" unconditionally, while the deadline branch for the same read
keeps the last state the isolate trusted. One branch keeps an operator's pause, the other lifts it.

## 1. Current state (audit)

`packages/runtime/src/deployment-pause.ts`:

- Lines 182-188, the docblock of `read`:

    ```ts
    /**
     * The flag as this isolate last saw it, re-read once the cache window lapses.
     * Fails open: when the scheduler cannot be reached the deployment is treated
     * as running, because a scheduler outage that took every function down with
     * it is the worse failure. The failed read is cached too, so an outage costs
     * one attempt per window rather than one per request.
     */
    ```

- Lines 200-214, the failure branch:

    ```ts
    const shared =
        pending ??
        fetchState(stub).catch(() => {
            if (generation === startedAt) {
                cached = { readAt: now(), state: NOT_PAUSED };
            }

            return NOT_PAUSED;
        });
    ```

- Lines 218-237, the deadline branch, which already does the right thing:

    ```ts
    return withDeadline(shared, () => {
        // The read is abandoned: the next caller starts its own, and until then
        // the last state this isolate trusted stands (running, if it never had one).
        const fallback = cached?.state ?? NOT_PAUSED;
    ```

- Test file `packages/runtime/__tests__/deployment-pause.test.ts` (673 lines). Pattern to copy:
  "reads the flag at most once per cache window" (lines 333-351) uses
  `vi.spyOn(Date, "now").mockReturnValue(...)` to move past `PAUSE_CACHE_MS`, and helpers `rpc()`,
  `setPaused()`, `countingShard()`, `fakeContext`, `ADMIN_TOKEN` defined at the top of the file.
  There is no test for "a failed read after a paused one".

## 2. Existing seams (do not reinvent)

- `cached` (the module-local last state) and `NOT_PAUSED`. Reuse the deadline branch's expression
  `cached?.state ?? NOT_PAUSED`.
- `PAUSE_CACHE_MS` is exported from `../src/deployment-pause` and already imported by the test file.

## 3. The behavioural contract to preserve

- An isolate that never read the flag successfully still fails open (treats the deployment as
  running) when the read fails. Existing tests cover this; they must stay green unchanged.
- The failed read is still cached for one window (one attempt per window, not per request).
- The generation guard (`generation === startedAt`) stays: a stale read must not overwrite a newer one.

## 4. Design decisions

- **Assumption about intent (stated by the reviewer, not discovered):** "fail open" in the docblock
  means "an isolate with no knowledge of the flag treats the deployment as running", not "any failed
  read lifts a pause". The deadline branch's comment ("the last state this isolate trusted stands")
  is the evidence. Chosen over leaving the asymmetry (an outage of a few seconds silently un-pauses
  every isolate that re-reads during it).
- Read `cached` at the moment the read fails (inside the `.catch`), not a value captured before the
  fetch started; a write that landed meanwhile is the newer truth.

## 5. Workstream — steps

**Commands you will need** (run from the worktree root):

| Purpose             | Command                                                                                                        | Expected |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | -------- |
| Install             | `pnpm install`                                                                                                 | exit 0   |
| Build deps          | `pnpm --filter "@lunora/runtime..." run build`                                                                 | exit 0   |
| One test file       | `pnpm --filter "@lunora/runtime" exec vitest run __tests__/deployment-pause.test.ts`                           | all pass |
| Package tests       | `pnpm --filter "@lunora/runtime" run test`                                                                     | all pass |
| Types               | `pnpm --filter "@lunora/runtime" run lint:types`                                                               | exit 0   |
| Format              | `pnpm exec oxfmt packages/runtime/src/deployment-pause.ts packages/runtime/__tests__/deployment-pause.test.ts` | exit 0   |
| Lint (after format) | `pnpm --filter "@lunora/runtime" run lint:eslint`                                                              | exit 0   |

**Scope.** In scope: `packages/runtime/src/deployment-pause.ts`,
`packages/runtime/__tests__/deployment-pause.test.ts`. Out of scope: `create-worker.ts`, the
scheduler package, the pause write path (`fetchState` with a body).

**Step 1 — install and build.** Verify: both commands exit 0.

**Step 2 — failing test.** Add to the `describe("createWorker — deployment pause", …)` block a test
"keeps a pause it already saw when a later flag read fails". Build a scheduler namespace inline (like
the test at lines 364-413 does) whose GET `/pause` answers `{ paused: true }` on the first read and
returns `new Response("down", { status: 500 })` on every later read (a 500 makes `fetchState` throw).
Answer `/instances` with `Response.json({ instances: [] })` as `pausableScheduler` does. Sequence:

1. `const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);`
2. First `worker.fetch(rpc(), {}, fakeContext)` → expect status 503 (paused).
3. `now.mockReturnValue(1_000_000 + PAUSE_CACHE_MS);` (window lapsed, so the next call re-reads).
4. Second call → the read fails → expect status **503** (still paused). Also assert the read count
   is 2, so the test proves a second read happened.
5. `now.mockRestore()` in a `finally`.

Add a second test "still fails open when the very first flag read fails": scheduler GET always 500;
expect the first call → 200 and the shard was reached. (If an existing test already asserts exactly
this, skip the second test and name the existing one in your report.)
Verify: one-test-file command → the first new test FAILS (status 200 instead of 503); everything
else passes.

**Step 3 — the fix.** In the `.catch` at line 203, compute the fallback from `cached` at that moment:
`const fallback = cached?.state ?? NOT_PAUSED;`, store `{ readAt: now(), state: fallback }` under the
same generation guard, and return `fallback`. Update the docblock (lines 182-188) to state the rule
exactly: a failed or abandoned read keeps the last state this isolate trusted; only an isolate that
never read the flag treats the deployment as running. Keep the outage-cost sentence.
Verify: one-test-file command → all pass.

**Step 4 — red without the fix (mandatory).** Commit (Step 6), then
`git diff 4a7c48bfd..HEAD -- packages/runtime/src/deployment-pause.ts | git apply -R`, run the
one-test-file command, confirm the new test fails, restore with
`git checkout -- packages/runtime/src/deployment-pause.ts`, confirm `git status --short` is clean.

**Step 5 — gates.** Format, lint, types, package tests. Verify: all exit 0.

**Step 6 — commit.** Stage the two files by path. Message:

```
fix(runtime): keep a seen pause when a later flag read fails

A failed pause-flag read cached "not paused" even when the isolate had last
seen the deployment paused; the deadline branch already kept the last state.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

## 6. Platform parity

Not applicable: no `ctx.*` surface or binding changes.

## 7. Phasing & ordering

| Phase | Work      | Gate                                                           |
| ----- | --------- | -------------------------------------------------------------- |
| 0     | Steps 1-6 | new test red without the fix; runtime tests, types, lint green |

## 8. Risks & STOP conditions

- **STOP** on drift or excerpt mismatch.
- **STOP** if an existing test that asserts fail-open behaviour fails after Step 3: that means the
  intent assumption in §4 is contradicted by a test; report its name and assertion.
- **STOP** if the fix seems to need a change outside the two in-scope files.
- **STOP** after two failed attempts at any one verification.

## 9. Open questions

1. (Owner) Is the §4 assumption right? If the maintainer wants any failed read to lift a pause, this
   plan is rejected and the deadline branch should change instead.

## Done criteria (all must hold)

- [ ] `git diff --stat 4a7c48bfd..HEAD` lists only the two in-scope files.
- [ ] `grep -n "state: NOT_PAUSED }" packages/runtime/src/deployment-pause.ts` prints nothing.
- [ ] New test passes and failed with the fix reverted (Step 4).
- [ ] `pnpm --filter "@lunora/runtime" run test`, `run lint:types`, `run lint:eslint` exit 0.
- [ ] One commit with the message above.
