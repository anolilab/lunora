# Plan 050: Expand advisor runtime lints (design + two high-value rules)

> **Executor instructions**: This is part design-spike, part implementation.
> Follow it step by step; produce the design artifact in Step 1 before coding.
> Run every verification command. On a "STOP conditions" item, stop and report.
> When done, update this plan's status row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat b51b440a..HEAD -- packages/advisor/src`
> If `packages/advisor/src/index.ts` or the runtime lints changed, compare against
> the "Current state" excerpts before proceeding; on a mismatch, STOP.

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `b51b440a`, 2026-06-17

## Why this matters

The advisor has 27 static lints over the declared schema but only **3** runtime
lints (`hotShard`, `indexUtilization`, `constraintValidator`). Runtime lints are
the highest-value class — they catch what static analysis can't: slow table scans,
indexes that exist but are never used, and unindexed query patterns observed in
production. Without them, the Studio Advisors table can only flag schema-shape
issues, not actual performance behavior. This plan adds the metrics-fed lints that
turn observed signal into actionable advisories.

## Current state

`packages/advisor/src/index.ts` (read it — 160+ lines):

- `RUNTIME_LINTS` (`:139`): `[hotShard, indexUtilization, constraintValidator]`.
- `STATIC_LINTS` (`:101-129`): 27 rules.
- Runtime lints read feeder-supplied signal off `LintContext`: `shardTraffic`,
  `tableScans`, `indexHits` (documented at `:131-138`). Absent signal → no-op.
  Run via `runAdvisor(ctx, { source: "runtime" })`.
- The runtime-lint pattern to copy: `packages/advisor/src/lints/runtime/hot-shard.ts`
  (read it fully — it shows the `Lint` shape, how it reads `LintContext.shardTraffic`,
  and the `Finding` it emits). Also read `index-utilization.ts` and
  `constraint-validator.ts` for the established conventions.
- The `LintContext` type and the runtime signal shapes are in
  `packages/advisor/src/types.ts` and the per-signal modules
  (`packages/advisor/src/index-usage.ts` → `AdvisorIndexHit`/`AdvisorTableScan`,
  `packages/advisor/src/shard-traffic.ts`, `packages/advisor/src/ae-metrics.ts`).
  Read these to know exactly what runtime data is already available.
- Analytics-Engine-backed metrics loading already exists: `ae-metrics.ts`
  (`loadAnalyticsRuntimeMetrics`, `AE_METRIC_EVENTS`) — the feeder path.

Conventions: each lint is a pure rule; `export default` is the per-rule module's
**sole** export (this is the documented-compliant pattern — keep it), then the
barrel re-exports as named in `index.ts` (`:51-80`). ESM, no `.js` extensions.
Lints are added to the `RUNTIME_LINTS` array (`:139`).

## Commands you will need

| Purpose       | Command                                          | Expected |
|---------------|--------------------------------------------------|----------|
| Build deps    | `pnpm --filter "@lunora/advisor..." run build`   | exit 0   |
| Advisor tests | `pnpm --filter "@lunora/advisor" run test`       | all pass |
| Typecheck     | `pnpm --filter "@lunora/advisor" run lint:types` | exit 0   |
| Lint          | `pnpm --filter "@lunora/advisor" run lint:eslint`| exit 0   |

(Do NOT run the aggregate `pnpm run test` in this sandbox — see plans/README.md.)

## Scope

**In scope**:
- A short design note (Step 1) listing candidate runtime lints, the signal each
  needs, and thresholds.
- Two new runtime lints (Step 2–3): start with `unused_index` (an index with zero
  observed `indexHits` over the window) and `slow_table_scan` (a table with scan
  volume above a threshold and no covering index). Adjust names to match existing
  conventions.
- `RUNTIME_LINTS` registration + barrel exports in `index.ts`.
- Tests for the new lints.

**Out of scope**:
- New runtime *signal* collection (only consume `tableScans`/`indexHits`/
  `shardTraffic`/AE metrics that already exist; if a lint needs a signal that
  isn't collected, note it in the design and STOP rather than building collection).
- The Studio rendering side (the table already renders any `Finding` uniformly).
- Changing the static lints.

## Steps

### Step 1: Write the design note

Create `plans/050-advisor-runtime-lints-design.md` (a sibling design artifact, not
code) listing: candidate runtime lints, the exact `LintContext` signal each
consumes (cite the field), a default threshold, the false-positive risk (sparse
metrics), and which two you'll implement first. Confirm the chosen two only need
already-collected signal.

**Verify**: the design note names two lints whose required signal exists on
`LintContext` today.

### Step 2: Implement `unused_index`

Add `packages/advisor/src/lints/runtime/unused-index.ts` following `hot-shard.ts`:
read `LintContext.indexHits` (+ the declared schema's indexes), and emit a `Finding`
for any declared index with zero hits over the window. No-op when signal is absent.
`export default` the lint (sole export). Register it in `RUNTIME_LINTS` (`index.ts:139`)
and add the barrel re-export (`index.ts` `:51-80` block).

**Verify**: `pnpm --filter "@lunora/advisor" run test` with the new test → pass.

### Step 3: Implement `slow_table_scan`

Add `packages/advisor/src/lints/runtime/slow-table-scan.ts`: read
`LintContext.tableScans`, emit a `Finding` when a table's scan volume exceeds the
threshold and it lacks a covering index for the observed access. No-op without
signal. Register + barrel-export as in Step 2.

**Verify**: `pnpm --filter "@lunora/advisor" run test` with the new test → pass.

### Step 4: Confirm static-only callers are unaffected

`runAdvisor(ctx, { source: "static" })` must NOT run the new runtime lints (they're
in `RUNTIME_LINTS`, not `STATIC_LINTS` — confirm by test).

**Verify**: a test asserts the new lints are skipped under `{ source: "static" }`
and emit nothing under `{ source: "runtime" }` when signal is absent.

## Test plan

- `packages/advisor/__tests__/` new tests (model after the existing runtime-lint
  tests — `ls packages/advisor/__tests__ | grep -iE "hot|index|runtime"`):
  - `unused_index`: an index with zero hits → one finding; an index with hits → none;
    no signal → no findings.
  - `slow_table_scan`: scans above threshold + no covering index → finding;
    below threshold → none; no signal → none.
  - source filtering: both skipped under `{ source: "static" }`.
- Verification: `pnpm --filter "@lunora/advisor" run test` → all pass.

## Done criteria

ALL must hold:

- [ ] `plans/050-advisor-runtime-lints-design.md` exists and lists candidate lints + signals + thresholds.
- [ ] Two new runtime lints exist, are registered in `RUNTIME_LINTS`, and barrel-exported.
- [ ] Each new lint is a no-op without runtime signal and skipped under `{ source: "static" }`.
- [ ] New tests cover findings, no-findings, and source filtering for both lints.
- [ ] `pnpm --filter "@lunora/advisor" run test`/`lint:types`/`lint:eslint` pass.
- [ ] `git status` shows only in-scope files modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- A candidate lint needs runtime signal that `LintContext` doesn't carry today —
  STOP, record it in the design note, and implement only lints whose signal exists.
- The `Finding` shape can't express the advisory (e.g. needs a new `Category`/
  `Level`) — STOP and report; extending the finding taxonomy is a separate change
  that affects the Studio renderer.
- `index-utilization.ts` already implements `unused_index` semantics under another
  name — STOP and report; don't duplicate it (pick a different second lint).

## Maintenance notes

- These lints' thresholds will need tuning against real metric volumes; expose them
  as options if false positives appear.
- Reviewer: confirm no-signal is a clean no-op (a static caller must never see a
  runtime advisory), and that thresholds are documented where a user can find them.
