# Plan 168 — Cross-shard transaction story (design spike)

- **Category**: architecture (competitive parity — gap #5 in `plans/README.md` Wave 14)
- **Priority**: P2
- **Effort**: XL · **Risk**: HIGH
- **Status**: TODO (spike first — no implementation until direction is ratified)
- **Baseline**: `70331e9b` (2026-07-21)
- **Goal**: decide Lunora's cross-shard write-consistency story. Either (a) offer
  a bounded cross-shard transaction/saga primitive, or (b) make the boundary a
  documented, lint-enforced non-goal. Convex offers global serializable
  transactions; once a Lunora app calls `.shardBy()`, cross-shard writes are not
  atomic — a real limitation for multi-entity invariants.

## Context (verified)

Storage is per-DO SQLite with OCC (`packages/do/src/shard-do.ts`). Cross-shard
**reads/relations** already exist (`packages/runtime/src/cross-shard-relations.ts`,
`query-coordinator.ts`, plus cross-shard rank/rankPage per prior work), but there
is no atomic cross-shard **write**. This is arguably a deliberate boundary — the
spike must decide, not assume.

## Phase 0 — Design spike (the only deliverable until ratified)

Produce a design doc (`plans/168-phase0-design.md`) covering:

- [ ] Enumerate the invariants users actually hit that need cross-shard atomicity
      (money transfer between tenants, unique-across-shards, etc.) — is the demand real?
- [ ] Option A — **saga / compensation** over DOs (reuse the workflow fan-out
      compensation machinery, plan 076): eventual, not ACID, but composable.
- [ ] Option B — **2PC/coordinator transaction** across DOs: stronger, higher
      latency + failure complexity on the DO model.
- [ ] Option C — **documented boundary + advisor lint**: no primitive; a static
      lint flags a mutation writing across shard boundaries, and docs state the
      guarantee. Cheapest, most honest if demand is thin.
- [ ] Recommendation + guarantee wording, latency/complexity cost, and a STOP/GO.

## Phase 1+ — Implement the chosen option

Only after Phase 0 is ratified. Scope defined by the chosen option.

## Exit criteria (spike)

- [ ] `plans/168-phase0-design.md` filed with a clear recommendation + go/no-go.
- [ ] If NON-GOAL: the advisor lint + docs boundary lands (the Wave 14 NON-GOAL routing).
- [ ] If BUILD: a follow-up implementation plan is filed with phased steps.

## Non-goals

- Writing any transaction code before the spike concludes.
- Weakening single-DO OCC guarantees (those stay as-is).
