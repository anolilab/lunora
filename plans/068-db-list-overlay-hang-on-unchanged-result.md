# Plan 068: Fix the optimistic overlay hanging when a mutator's result doesn't change a list

> **Executor instructions**: Follow this plan step by step. This is a
> correctness fix with a design subtlety — **write the failing characterization
> test first (Step 1), then fix (Step 2).** The test is the primary deliverable
> and the source of truth. If the fix appears to need a server-side protocol
> change, STOP and report (see STOP conditions). When done, update the status
> row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 9f779358..HEAD -- packages/db/src/collection-options.ts packages/db/src/define-mutators.ts packages/client/src/lunora-client.ts`
> If any changed, compare the "Current state" excerpts against the live code; on
> a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (but read 071's notes — both touch the mutator/watermark path)
- **Category**: bug
- **Planned at**: commit `9f779358`, 2026-06-29

## Why this matters

When a `@lunora/db` app binds custom mutators (`bindMutators`) over a
**list-synced** collection (`lunoraCollectionOptions({ list })`) with a
`CheckpointRegistry`, the optimistic overlay is held until the server confirms
the write's mutation id (`awaitMutationId(appliedSeq)`). For a list collection,
the gate that resolves that promise is advanced **only inside `onRows`** — i.e.
only when a data frame actually arrives. But the DO suppresses a list frame when
the post-write result is byte-identical to the last one
(`pushSubscriptionData` early-returns on an unchanged `lastJson`). So a confirmed
mutator whose authoritative result does **not** change the subscribed list (a
no-op update, or a write to a row filtered out of this list) produces no frame →
`onRows` never fires → the gate never advances → `awaitMutationId` never
resolves → **the optimistic overlay is stuck forever**, and the mutation's
transaction promise never settles. The code comment at the resolve site shows the
author anticipated the hang for the _changed_ case and mitigated it; the
_unchanged_ case is the gap.

## Current state

- `packages/db/src/collection-options.ts` (around lines 168–195) — the list path
  advances the gate only from `onRows`:

    ```ts
    emit?.(toMap(data as TRow[], getKey));
    onReady?.();

    // ... a `list` frame carries no per-frame watermark, so advance
    // from the client's server-confirmed custom-mutator watermark ...
    // instead of `awaitMutationId` hanging forever after the write is accepted.
    if (options.shape === undefined) {
        checkpoints.resolve({ mutationId: options.client.confirmedMutationWatermark() });
    }
    ```

    `onRows` (which wraps the above `emit` + resolve) is the callback passed to
    `options.client.subscribe(...)` for the list path. It only runs when a
    data/delta frame arrives.

- `packages/db/src/define-mutators.ts` (around lines 169–182) — the mutator's
  `mutationFn` pushes the write, then **awaits** the gate:

    ```ts
    mutationFn: async () => {
        let appliedSeq = 0;

        await runOutboxMutation(async () => {
            appliedSeq = await pushSerialized(mutator.serverRef, args as Record<string, unknown>);
        });

        // Hold the overlay until the synced row lands (the poke echoes
        // this client's `lastMutationId`). Skipped when no watermark
        // stream is wired — the by-value diff converges in place.
        if (context.checkpoints) {
            await context.checkpoints.awaitMutationId(appliedSeq);
        }
    },
    ```

- `packages/client/src/lunora-client.ts:761-763` — the client's watermark is
  already current after the push: `callMutator`'s ack (`onMutationAck`) updates
  `clientWatermarks`, and `confirmedMutationWatermark(shardKey)` reads it. So the
  _value_ the gate needs is known the moment `pushSerialized` returns — the only
  thing missing is something to push that value into the gate when no list frame
  arrives.

- `packages/do/src/shard-do.ts:6587` — the suppression that removes the frame:

    ```ts
    if (existing?.lastJson === json) {
        existing.tables = outcome.tables;

        return; // no frame sent — onRows never fires for this sub
    }
    ```

## The fix space (read before choosing)

The overlay must drop once the authoritative state is reflected in the synced
base. Two cases after a confirmed push (`appliedSeq = S`):

- **Case A — result changes the list**: a frame arrives → `onRows` → gate
  advances. Works today. Dropping the overlay only when the synced row lands is
  what avoids a flicker (optimistic row replaced in place).
- **Case B — result does not change the list**: no frame → gate never advances →
  hang. In this case the synced base **already** reflects the authoritative state
  (the row is unchanged), so dropping the overlay as soon as the push is
  confirmed is correct and cannot flicker (there is no different synced row
  coming).

The preferred fix is **client-only**: in the list path, advance the gate from the
push-confirmation as a backstop, taking the max with `onRows`, so Case B resolves
while Case A still resolves via `onRows`. The subtlety is ordering — in Case A the
RPC ack and the WS frame race, so a naive "advance on ack" could drop the overlay
just before the synced row lands (flicker). Mitigate by deferring the backstop
(e.g. resolve it on a microtask/next tick after the push settles, so a same-tick
`onRows` wins). The characterization test in Step 1 pins Case B; a Case-A
no-flicker assertion guards the regression.

If a correct client-only fix proves infeasible and the only sound option is a
server-side change (e.g. the DO emitting a minimal watermark-only frame on a
suppressed list result so `onRows` can advance the gate), **STOP and report** —
that is a larger protocol change to be decided separately.

## Commands you will need

| Purpose          | Command                                     | Expected on success      |
| ---------------- | ------------------------------------------- | ------------------------ |
| Build deps first | `pnpm run build:packages`                   | exit 0 (run once)        |
| Typecheck        | `pnpm --filter "@lunora/db" run lint:types` | exit 0, no errors        |
| Tests            | `pnpm --filter "@lunora/db" run test`       | all pass, incl. new test |
| Lint             | `pnpm run lint:eslint`                      | exit 0                   |

## Scope

**In scope**:

- `packages/db/src/collection-options.ts` and/or `packages/db/src/define-mutators.ts`
  — the client-side overlay-drop wiring for the list path.
- `packages/db/__tests__/collection-options.test.ts` and/or
  `packages/db/__tests__/define-mutators.test.ts` — the failing→passing test.

**Out of scope** (unless a STOP-and-report escalation approves it):

- `packages/do/src/shard-do.ts` — the frame-suppression optimization stays; do
  not disable it.
- `packages/client/src/lunora-client.ts` — `callMutator`/watermark tracking is
  correct; do not change it.
- The shape path (`options.shape !== undefined`) — it advances via `onCheckpoint`
  from pokes and is not affected by this bug.

## Git workflow

- Branch: `advisor/068-db-list-overlay-hang`.
- Commit style: `fix(db): drop list optimistic overlay on unchanged mutator result`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Write the failing characterization test

In `packages/db/__tests__/` (model after `define-mutators.test.ts`'s
`vi.mock("@tanstack/db")` harness and `collection-options.test.ts`'s subscription
mock), construct:

- a list-synced collection via `lunoraCollectionOptions({ list, client })` with a
  fake client whose `subscribe` lets the test control when `onRows` fires and
  whose `callMutator` resolves with `{ applied: true }` and advances
  `confirmedMutationWatermark` to `appliedSeq`;
- `bindMutators(client, { collections, checkpoints }, { ... })`;
- fire a bound mutator, let the push resolve, and **do NOT deliver a list frame**
  (simulating the DO's suppressed no-change result).

Assert that the mutation's transaction `mutationFn` promise **resolves** (the
overlay drops). Before the fix, this test must **hang/fail** (use a bounded
`await` with a timeout via `vi.useFakeTimers()` / `await Promise.race([...])` so
the failure is a clean assertion, not a hung test runner).

Also add the Case-A guard: when a list frame _does_ arrive, the overlay drops via
`onRows` and does not drop prematurely.

**Verify (pre-fix)**: `pnpm --filter "@lunora/db" run test` → the new Case-B test
FAILS (overlay never drops). Record this failure in your report.

### Step 2: Implement the client-only backstop

Advance the list gate from the push-confirmation as a deferred backstop (max with
`onRows`), so Case B resolves without a frame while Case A keeps resolving via
`onRows` with no flicker. Wire it where the `CheckpointRegistry` and the push
result are both in reach (the `mutationFn` in `define-mutators.ts` knows
`appliedSeq`; `collection-options.ts` owns the registry and the list/shape
distinction). Keep the shape path untouched.

**Verify (post-fix)**: `pnpm --filter "@lunora/db" run test` → the Case-B test now
PASSES and the Case-A no-flicker test still passes.

## Test plan

- New tests in `packages/db/__tests__/` (collection-options or define-mutators,
  whichever the harness fits best):
    - **Case B (the bug)**: confirmed push + no list frame → overlay drops
      (mutationFn resolves). Fails before the fix, passes after.
    - **Case A (no regression)**: confirmed push + a list frame whose result
      changed → overlay drops via `onRows`, not prematurely.
    - the no-checkpoints path (`context.checkpoints` omitted) is unaffected.
- Structural pattern: `define-mutators.test.ts` for the mutator/transaction
  mock; `collection-options.test.ts` for the subscribe/onRows mock.
- Verification: `pnpm --filter "@lunora/db" run test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter "@lunora/db" run lint:types` exits 0.
- [ ] `pnpm --filter "@lunora/db" run test` exits 0; the Case-B test passes (and
      demonstrably failed before the fix — note this in your report).
- [ ] `pnpm run lint:eslint` exits 0.
- [ ] `packages/do/src/shard-do.ts` is unchanged (`git status`) — the fix is
      client-only.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back if:

- A correct client-only fix is infeasible and the only sound option is a
  server-side protocol change (DO emitting a watermark-only frame on suppressed
  results). Report the analysis; do not implement the server change under this
  plan.
- The Case-A no-flicker behavior cannot be preserved alongside the Case-B fix
  (the backstop drops the overlay before the synced row lands in Case A).
- Any "Current state" excerpt no longer matches the live code.

## Maintenance notes

- The crux a reviewer must scrutinize: the backstop must not introduce a flicker
  in Case A. The ordering between the RPC ack and the WS data frame is the risk.
- This bug is specific to the **list** path. If a future change makes the shape
  path also suppress no-change pokes without echoing a watermark, the same class
  of hang could appear there — note it.
- Related: plan 071 adds characterization tests for the mutator/watermark
  self-healing path; the harness it builds may be reusable here.
