# Plan 136: Incremental external-source table mode (`mode: "incremental"`)

> **Cut from the 1.0 surface (2026-07-16).** `ExternalSourceMode` briefly
> advertised `"incremental"` in its public union while `defineSchema` threw
> "not yet implemented" at runtime — a typed API whose only behavior was a crash.
> For 1.0 the union is narrowed to `"full-pull"` (a compile-time error instead of
> a runtime throw) and the incremental-only `reconcileEveryMs` knob is removed
> from `ExternalSourceDefinition`. This plan captures the scope findings so the
> work isn't lost.

## Status

- **Status**: TODO
- **Priority**: P3 (deferred, demand-gated — same posture as plan 133's Phase 3
  live CDC; do not build speculatively)
- **Effort**: L (spans `@lunora/server`, `@lunora/do`, `@lunora/codegen`,
  `@lunora/advisor`, `@lunora/hyperdrive` docs)
- **Risk**: HIGH — touches the ingest boundary (non-deterministic external data
  entering the deterministic write path) and delete-visibility correctness
- **Origin**: plan 077 (Wave 7, Hyperdrive → per-agent DO shape ingest) §3.3;
  the Phase-0 bench set a ~10k row cap on full-pull with incremental as the
  "above the cap" future mode

## What incremental mode was meant to do

Full-pull (shipped, the default and now only mode) reads the **whole** tenant
membership each poll tick and diffs it against the local table
(`runExternalSourceTick` in `packages/do/src/external-source-materialize.ts`:
the table IS the baseline, absence = delete). That observes upstream deletes but
costs a full read per tick — the Phase-0 bench (`packages/do/__bench__/
external-source-materialize-tick.bench.ts`) put the steady tick at ~20 ms at 10k
rows, hence the ~10k cap and size-scaled cadence.

Incremental mode would pull **only rows changed since a watermark** (cheap for
large, low-churn slices) at the price of being blind to deletes, requiring a
companion delete-visibility path (a soft-delete column upstream, or a periodic
`reconcileEveryMs` full-pull sweep to GC tombstones).

## Scope findings — why this is not a moderate change

Verified against the shipped ingest path at the 2026-07-16 cut:

1. **No cursor declaration exists.** `ExternalSourceDefinition` has `query` (the
   full-membership SQL) + `tenantBy` (shard-key → params). Incremental needs a
   declared cursor/watermark column (e.g. `updated_at`) **and** a convention for
   binding the watermark into the query alongside `tenantBy`'s positional params
   (`$1`/`?` collision), plus `>` vs `>=` tie/clock-skew semantics — new public
   protocol surface, not a flag.
2. **No durable watermark storage.** The poll loop's only state is per-instance
   in-memory `WeakMap`s in the codegen-emitted subclass
   (`sourceClientCache`/`sourcePollAtCache`, `packages/codegen/src/emit.ts`
   `pollExternalSources` override). A watermark must survive hibernation/eviction
   → a new DO-SQLite meta table (or storage key) per (table, shard), with
   migration wiring.
3. **The apply path is full-membership by construction.**
   `diffExternalSource`/`readExternalSourceBaseline` treat "absent from pulled"
   as delete. Incremental needs a second, upsert-only materialize entry point
   (insert-or-update by `_id`, never delete) while the reconcile sweep reuses the
   full diff — two code paths through `applyCdcChanges` where today there is one.
4. **The reconcile sweep is its own scheduler.** `reconcileEveryMs` needs a
   second durable last-reconcile timestamp per (table, shard) and interleaving
   rules with `refresh` cadence in the emitted poll loop.
5. **A new advisor STOP lint is required before shipping.** Plan 133 §"Prefer
   these first" already specifies it: `external_source_incremental_no_delete_path`
   — an incremental source with neither a soft-delete column nor
   `reconcileEveryMs` silently accumulates phantom rows. The IR seams for it
   (`hasReconcile`, `mode` on `ExternalSourceIR` / `AdvisorExternalSource`) are
   kept — see below.
6. **Codegen emission changes.** The emitted `pollExternalSources` override must
   branch per mode, read/persist watermarks, and schedule reconciles; golden
   fixtures + `emit-external-source.test.ts` grow accordingly.

Cross-package protocol + persistence machinery ⇒ cut, not rushed in.

## The seams kept for the return (verified at the cut)

- `type ExternalSourceMode = "full-pull"` (`packages/server/src/types.ts`) — the
  alias stays exported; the return re-widens the union.
- `defineSchema`'s `validateExternalSources` (`packages/server/src/schema.ts`)
  keeps a defensive unknown-mode guard for untyped JS callers.
- Codegen discovery (`parseSourceCall`, `packages/codegen/src/discover-schema.ts`)
  still captures `mode` (any literal) and `hasReconcile` from source text into
  `ExternalSourceIR`; the advisor runtime feeder (`packages/advisor/src/schema.ts`
  `fromServerSchema`) reads `reconcileEveryMs` through a widening cast. Both feed
  the future `external_source_incremental_no_delete_path` lint unchanged.
- The pure diff already anticipates it: `ExternalSourceDiffResult.nextBaseline`
  is documented "or persist for an incremental cursor"
  (`packages/do/src/external-source-diff.ts`).

## Sketch of the return (post-1.0, when a real workload passes the ~10k cap)

1. Design the cursor surface: `cursor: { column, query }` (a second,
   watermark-parameterized SQL) or a placeholder convention on `query`; settle
   tie semantics (re-pull `>=` + idempotent upsert is safest).
2. Durable per-(table, shard) watermark + last-reconcile in a
   `__external_source_meta` DO-SQLite table; read/write from the emitted poll
   override.
3. `materializeExternalRowsIncremental` (upsert-only) in `@lunora/do` beside the
   full diff; reconcile tick calls the existing `runExternalSourceTick`.
4. Re-widen `ExternalSourceMode`, restore `reconcileEveryMs`, emit the mode
   branch in codegen, ship `external_source_incremental_no_delete_path` as a
   STOP-severity lint, and require either `reconcileEveryMs` or a declared
   soft-delete column at `defineSchema` time.
5. Docs: `packages/hyperdrive/docs/index.mdx` "Refresh cadence" section.

## Commands

| Purpose        | Command                                    | Expected |
| -------------- | ------------------------------------------ | -------- |
| Server tests   | `pnpm --filter "@lunora/server" run test`  | pass     |
| DO tests       | `pnpm --filter "@lunora/do" run test`      | pass     |
| Codegen golden | `pnpm --filter "@lunora/codegen" run test` | pass     |
| Advisor tests  | `pnpm --filter "@lunora/advisor" run test` | pass     |
| Affected suite | `pnpm run test:affected`                   | pass     |
