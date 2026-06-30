# Plan 069: Characterization tests for client shape re-seed on epoch fork / base divergence

> **Executor instructions**: This is a **tests-only** plan. Do NOT change any
> source under `src/` — if a test you write reveals a real bug, STOP and report
> it (do not fix it here). Follow the steps, run the verification commands, and
> update the status row in `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 9f779358..HEAD -- packages/client/src/lunora-client.ts`
> If it changed, compare the "Current state" excerpt against the live code; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `9f779358`, 2026-06-29

## Why this matters

The client's shape-poke handler has a self-healing branch that, on `pokeEnd`,
detects when the server's changelog timeline forked (epoch mismatch) or the
client's resume base diverged from the poke's `baseCheckpoint`, and re-seeds the
shape from scratch instead of applying a diff onto a stale base. This is the
safety net that prevents a silently stale local view after a shard reset / PITR /
recycled DO. It currently has **no direct unit coverage** — a regression here
would be invisible (the view just quietly drifts). These characterization tests
lock the branch in.

## Current state

- `packages/client/src/lunora-client.ts` — the `pokeEnd` handler (around lines
  3370–3425). The fork/divergence detection and re-seed:

    ```ts
    const epochForked = buffer.epoch !== undefined && state.serverEpoch !== undefined && buffer.epoch !== state.serverEpoch;
    const baseDiverged = buffer.baseCheckpoint !== undefined && state.serverCursor !== undefined && state.serverCursor !== buffer.baseCheckpoint;

    if (epochForked || baseDiverged) {
        // changelog timeline forked / base diverged → re-seed from scratch
        // ... this.emitShapeRows(state);  (re-emits the full current rowset)
    }
    // ... otherwise apply the diff, advance serverCursor/serverEpoch/lastMutationId
    ```

    Read the full block before writing the tests so your assertions match the exact
    state transitions (`serverEpoch`, `serverCursor`, `lastMutationId`,
    `onCheckpoint`).

- The poke-buffer is built across `pokeStart` (line ~3347:
  `{ baseCheckpoint, epoch, lastMutationId: new Map(), parts: new Map() }`),
  `pokePart` (accumulates row ops + per-shape `lastMutationId`), and `pokeEnd`
  (applies atomically). Tests must drive all three to exercise the branch.

## Commands you will need

| Purpose          | Command                                         | Expected on success       |
| ---------------- | ----------------------------------------------- | ------------------------- |
| Build deps first | `pnpm run build:packages`                       | exit 0 (run once)         |
| Tests            | `pnpm --filter "@lunora/client" run test`       | all pass, incl. new tests |
| Typecheck        | `pnpm --filter "@lunora/client" run lint:types` | exit 0                    |
| Lint             | `pnpm run lint:eslint`                          | exit 0                    |

## Scope

**In scope** (the only files you should modify):

- `packages/client/__tests__/shape-subscription.test.ts` — add cases (or a new
  sibling test file `shape-reseed.test.ts` if the existing file's harness doesn't
  fit cleanly).

**Out of scope** (do NOT modify):

- Any `packages/client/src/**` file. This is tests-only.

## Git workflow

- Branch: `advisor/069-test-client-shape-reseed`.
- Commit style: `test(client): cover shape re-seed on epoch fork / base divergence`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Study the existing harness

Read `packages/client/__tests__/shape-subscription.test.ts` to learn how it
stands up a `LunoraClient` with a fake transport and feeds it `pokeStart` /
`pokePart` / `pokeEnd` frames, and how it inspects shape subscription state and
emitted rows. Reuse that harness.

### Step 2: Add the re-seed characterization cases

Cover, at minimum:

1. **Epoch fork** — subscribe to a shape and seed it; then deliver a poke whose
   `epoch` differs from the subscription's `serverEpoch`. Assert the client
   re-seeds (the full current rowset is re-emitted) rather than applying the diff
   onto the stale base, and that `serverEpoch` updates to the new epoch.
2. **Base divergence** — same epoch, but the poke's `baseCheckpoint` does not
   match the subscription's `serverCursor`. Assert re-seed.
3. **Happy path (no fork)** — a poke whose `epoch` matches and whose
   `baseCheckpoint` equals the current `serverCursor` applies the diff normally
   (no re-seed), advances `serverCursor`, and fires `onCheckpoint` with the
   expected `{ checkpoint, mutationId }`.

Assert the observable outcomes (emitted rows, `onCheckpoint` payloads), not
private fields, where the harness allows.

**Verify**: `pnpm --filter "@lunora/client" run test` → all pass, including the
new cases.

## Test plan

- New cases as listed in Step 2, in `shape-subscription.test.ts` (or
  `shape-reseed.test.ts`).
- Structural pattern: the existing shape-subscription tests in that file.
- Verification: `pnpm --filter "@lunora/client" run test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter "@lunora/client" run test` exits 0 with the new cases.
- [ ] `pnpm --filter "@lunora/client" run lint:types` exits 0.
- [ ] `pnpm run lint:eslint` exits 0.
- [ ] No `packages/client/src/**` file is modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back if:

- The `pokeEnd` handler no longer matches the "Current state" excerpt.
- A test reveals the re-seed branch does NOT fire when it should (or fires when
  it shouldn't) — that's a real bug; report it, don't fix it here.
- The existing harness can't reach the `pokeStart`/`pokePart`/`pokeEnd` path
  without modifying `src/` — report rather than reaching into source.

## Maintenance notes

- These tests guard the stale-view safety net. If the poke protocol's resume
  semantics change (epoch/baseCheckpoint meaning), these tests must be updated in
  lockstep — they encode the current contract.
