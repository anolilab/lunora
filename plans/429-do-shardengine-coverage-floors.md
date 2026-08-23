# Plan 429: Put coverage floors on `@lunora/do` and first tests on the durable-stream runner

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/do/vitest.config.ts packages/shard-engine/vitest.config.ts packages/shard-engine/__tests__`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: plans/428-shardengine-stream-generation.md (write the `decideDurableAttach` tests against the post-428 decision table)
- **Category**: tests
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`packages/do` (12,949 lines of `src`, the shard RPC/hibernation surface) has **no coverage threshold at all**: its `vitest.config.ts` hand-mirrors the shared coverage block but omits `thresholds`, the one key the shared helper always sets. The helper's own docstring (`tools/get-vitest-config.ts:26-32`) says the workerd-gated exemption is "don't inherit this default", not "no threshold anywhere", and points at `client`'s config as the pattern: an inline floor measured against the non-workerd (`mocks`) project alone. `shard-engine`'s floors (25/43/46/46 vs the 70/80/80/80 default) are labeled "a RATCHET… every engine unit test added should raise them" and have never moved since the extraction commit. Concretely under this gap: `durable-stream-runner.ts` — including the exported pure state machine `decideDurableAttach` — has zero direct tests, and plan 428's bug shipped there.

## Current state

- `packages/do/vitest.config.ts:7-24` — inline `coverage` object with `provider`, `reporter`, `include`, `exclude` — no `thresholds`. Two projects: `mocks` (always on) and `workerd` (gated by `LUNORA_WORKERD_TESTS=1`, coverage-free by design).
- `packages/shard-engine/vitest.config.ts:19`:
    ```ts
    export default getVitestConfig({ test: { environment: "node" } }, { branches: 25, functions: 43, lines: 46, statements: 46 });
    ```
    with the RATCHET comment above it ("Do not lower them").
- `packages/client/vitest.config.ts` — the exemplar: an inline floor on a workerd-gated package, measured against its `mocks` project, with a file-level comment explaining the numbers.
- `packages/shard-engine/__tests__/` — ~40 suites, none covering `durable-stream.ts` / `durable-stream-runner.ts`.

## Commands you will need

| Purpose                 | Command                                                  | Expected on success                    |
| ----------------------- | -------------------------------------------------------- | -------------------------------------- |
| Install                 | `pnpm install`                                           | exit 0                                 |
| Build deps              | `pnpm --filter "@lunora/do..." run build`                | exit 0                                 |
| Measure do coverage     | `pnpm --filter "@lunora/do" run test:coverage`           | coverage table printed (mocks project) |
| Measure engine coverage | `pnpm --filter "@lunora/shard-engine" run test:coverage` | coverage table printed                 |
| Tests                   | `pnpm --filter "@lunora/shard-engine" run test`          | all pass                               |

## Scope

**In scope**:

- `packages/do/vitest.config.ts` — add a `thresholds` block
- `packages/shard-engine/vitest.config.ts` — raise the ratchet to the new measured numbers
- `packages/shard-engine/__tests__/durable-stream-runner.test.ts` — create (if plan 428 already created it, extend it)
- `packages/shard-engine/__tests__/durable-stream.test.ts` — create (store-layer round-trip: claim → append → read → finish → trim)

**Out of scope**:

- Any `src/` behavior change in either package.
- The workerd projects (they stay coverage-free per the documented v8/inspector limitation).
- Other packages' thresholds.

## Git workflow

- Branch: `improve/wave22-shard-engine`
- Commit: `test(shard-engine): cover durable streams, pin floors`

## Steps

### Step 1: Write the durable-stream tests

- `durable-stream-runner.test.ts`: the full `decideDurableAttach` decision table (post-428: run-missing×resuming → interrupted; terminal×resuming → replay-terminal; terminal×fresh → reclaim; dead-running×resuming → interrupted; dead-running×fresh → reclaim; live×matching-generation → attach; generation-mismatch → interrupted), plus one `DurableStreamRunner.attach` behavioral case per decision using an in-memory `SqlExec` double — copy the double from an existing engine suite (e.g. whatever `ctx-db.cdc.test.ts` uses; read it first).
- `durable-stream.test.ts`: claim/append/read/finish round-trip, TTL trim (`trimStreamRuns`), and the `sinceChunk` filter of `readStreamChunks`.

**Verify**: `pnpm --filter "@lunora/shard-engine" run test` → all pass, new suites included.

### Step 2: Measure and raise the shard-engine ratchet

Run the coverage command, read the summary, and set the four numbers in `vitest.config.ts` to sit **just under** the new measurement (1–2 points of slack, same policy as the existing comment). They must be ≥ the current 25/43/46/46 — the comment says "Do not lower them".

**Verify**: `pnpm --filter "@lunora/shard-engine" run test:coverage` → exit 0 with the new floors.

### Step 3: Pin a floor on `@lunora/do`

Run the do coverage command (mocks project). Add a `thresholds` object to the inline `coverage` block with the measured numbers minus 1–2 points of slack, plus a one-line comment mirroring `client`'s: measured against the `mocks` project alone, workerd project intentionally uncovered.

**Verify**: `pnpm --filter "@lunora/do" run test:coverage` → exit 0.

## Test plan

Covered by Steps 1–3; the new suites are the deliverable. Model structure on `packages/shard-engine/__tests__/aggregate-tally.test.ts` (small, pure-function-heavy suite).

## Done criteria

- [ ] `packages/shard-engine/__tests__/durable-stream-runner.test.ts` and `durable-stream.test.ts` exist and pass
- [ ] `packages/do/vitest.config.ts` has a non-zero `thresholds` block; `test:coverage` exits 0
- [ ] `packages/shard-engine/vitest.config.ts` floors raised (never lowered); `test:coverage` exits 0
- [ ] `pnpm --filter "@lunora/shard-engine" run lint:types` and `lint:eslint` exit 0
- [ ] No files outside the in-scope list modified

## STOP conditions

- Plan 428 is not yet merged into your branch and the decision table you're testing doesn't match its post-428 shape (sequence after 428 on the same branch).
- `@lunora/do`'s coverage run stalls or OOMs (the studio had this problem under v8 coverage) — report the measured behavior instead of shipping a zero floor.
- Measured do coverage is so low (<20% lines) that a floor would be meaningless — report the number and let the reviewer pick the policy.

## Maintenance notes

- Both floors are ratchets: raise them when tests land, never lower. The `do` comment should say so.
- Reviewer: check the new tests assert stream _content_ (chunk seq + data), not just call counts.
