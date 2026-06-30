# Plan 071: Characterization tests for custom-mutator handler failure and watermark self-healing

> **Executor instructions**: This is a **tests-only** plan. Do NOT change any
> source under `src/` — if a test reveals a real bug, STOP and report it. Follow
> the steps, run the verification commands, update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 9f779358..HEAD -- packages/do/src/shard-do.ts`
> If it changed, compare the "Current state" excerpt against the live code; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `9f779358`, 2026-06-29

## Why this matters

The custom-mutator watermark protocol is the subtlest invariant in the sync
engine: a push is classified against `__client_watermark` _before_ the handler
runs, the watermark advances _after_ the handler's writes commit, and the advance
is deliberately **not atomic** with the handler. The design relies on a precise
self-healing property — a handler that throws (or a crash between commit and
advance) must **not consume the client's sequence**, so the client's resend
re-runs idempotently and the watermark catches up. If a refactor ever advanced
the watermark on a failed handler, a client's failed write would be silently
swallowed (the resend would be acked as a replay and never run). This property
has client-watermark tests for the ordering/classification, but the
**handler-failure** branch — the one that protects against silent write loss —
needs explicit coverage.

## Current state

- `packages/do/src/shard-do.ts` — the dispatch path (around lines 1944–1995):

    ```ts
    const mutatorClass = this.isCustomMutator(payload.functionPath) ? this.classifyClientMutation() : undefined;
    const watermarkShortCircuit = this.rejectNonNextMutation(payload.functionPath, mutatorClass, dispatchStartedAt);
    if (watermarkShortCircuit !== undefined) {
        return watermarkShortCircuit; // out-of-order / replay never reaches the handler
    }
    // ... idempotency cache check ...
    const result = await this.handleRpc(payload.functionPath, payload.args ?? {});
    this.persistIdempotentResult(result);
    // Advance the watermark only after the handler committed; NOT atomic.
    if (mutatorClass?.kind === "next") {
        this.advanceClientMutationWatermark();
    }
    ```

    The comment at lines 1980–1995 is the contract to encode: _"A crash after the
    handler commits but before this advance leaves the watermark behind — the
    client's unacked replay re-classifies as `next` ... and re-runs idempotently,
    re-advancing. So the gap self-heals; it never drops or double-applies the
    write."_ Critically: if `handleRpc` **throws**, `advanceClientMutationWatermark`
    is never reached (the throw routes to the error path), so a failed mutator does
    not consume the sequence.

## Commands you will need

| Purpose          | Command                                     | Expected on success       |
| ---------------- | ------------------------------------------- | ------------------------- |
| Build deps first | `pnpm run build:packages`                   | exit 0 (run once)         |
| Tests            | `pnpm --filter "@lunora/do" run test`       | all pass, incl. new tests |
| Typecheck        | `pnpm --filter "@lunora/do" run lint:types` | exit 0                    |
| Lint             | `pnpm run lint:eslint`                      | exit 0                    |

## Scope

**In scope** (the only files you should modify):

- `packages/do/__tests__/shard-do.client-watermark.test.ts` — add the
  handler-failure / self-heal cases (or a new sibling
  `shard-do.mutator-failure.test.ts` using the same harness).

**Out of scope** (do NOT modify):

- Any `packages/do/src/**` file. Tests-only.

## Git workflow

- Branch: `advisor/071-test-mutator-failure-watermark-selfheal`.
- Commit style: `test(do): cover mutator handler-failure watermark self-healing`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Study the existing harness

Read `packages/do/__tests__/shard-do.client-watermark.test.ts` and
`packages/do/__tests__/ctx-db.client-watermark.test.ts`. Learn how they register
a custom mutator (the `isCustomMutator` / `resolveShape`-style subclass hook),
build a push request carrying `x-lunora-client-id` + `x-lunora-client-seq`, drive
it through dispatch, and read `__client_watermark`. Reuse that harness.

### Step 2: Add the failure / self-heal cases

Cover, at minimum:

1. **Handler throws → watermark NOT advanced**: register a mutator whose server
   impl throws. Push `clientSeq = watermark + 1`. Assert the response is an error
   AND `__client_watermark` is unchanged (the sequence was not consumed).
2. **Resend after failure re-runs**: after case 1, the client fixes the condition
   (or the mutator now succeeds) and resends the **same** `clientSeq`. Assert it
   is classified `next` (not a replay), runs the handler, and advances the
   watermark. This is the self-heal.
3. **Replay of a succeeded write is idempotent**: push `seq = N` (succeeds,
   watermark → N), then resend `seq = N`. Assert the handler does NOT run again
   (idempotency cache short-circuit) and the watermark stays N.
4. **Out-of-order rejected without running**: with watermark at N, push
   `seq = N + 2`. Assert it's rejected (`OUT_OF_ORDER`-style) and the handler
   never ran and the watermark is unchanged.
5. **Advance-gap self-heal** (the documented crash window): simulate "handler
   committed but advance didn't" by... only if the harness can express it without
   a source hook (e.g. asserting that re-classification of an unacked replay
   treats a missing/lower watermark row as `next`). If it can't be expressed
   without modifying `src/`, note that in your report and skip — do NOT add a
   source hook.

Assert handler-ran vs not via a spy/counter on the mutator's server impl.

**Verify**: `pnpm --filter "@lunora/do" run test` → all pass.

## Test plan

- New cases as in Step 2, in `shard-do.client-watermark.test.ts` (or a sibling).
- Assertion basis: `__client_watermark` value, a handler-invocation counter, and
  the response classification.
- Structural pattern: the existing client-watermark tests.
- Verification: `pnpm --filter "@lunora/do" run test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter "@lunora/do" run test` exits 0 with the new cases.
- [ ] `pnpm --filter "@lunora/do" run lint:types` exits 0.
- [ ] `pnpm run lint:eslint` exits 0.
- [ ] Cases 1–4 of Step 2 are covered (note case 5 if unreachable without a
      source hook).
- [ ] No `packages/do/src/**` file is modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back if:

- The dispatch path no longer matches the "Current state" excerpt.
- A test shows a **failed** mutator DOES advance the watermark (silent
  write-loss) — that's a real, serious bug; report it immediately, do not fix here.
- Reaching a case requires a test-only hook in `src/` — report instead of adding it.

## Maintenance notes

- The "failed handler must not consume the sequence" invariant is the single most
  important thing these tests guard. Any future change to where
  `advanceClientMutationWatermark` is called relative to `handleRpc` must keep
  these green.
- The advance is intentionally non-atomic with the handler; a reviewer changing
  that ordering should re-read the contract comment at lines 1980–1995.
