# Plan 557 — Design the split of `shard-do.ts`

**Baseline:** `4a7c48bfd` (2026-11-11)
**Status:** TODO (plan only — design first; L)
**Priority / effort / risk:** P3 / L / MED. **Category:** tech-debt.

## 0. Headline finding

`packages/do/src/shard-do.ts` is 20,338 lines; the abstract `ShardDO` class starts at line 2236 and has
about 586 member declarations. `packages/runtime/src/create-worker.ts` is 7,400 lines.
`plans/135-stable-1.0-roadmap.md:395` defers the split ("`shard-do.ts` god-file split (TECH-01) —
maintainability, not correctness"). There is no plan for how to do it.

## 1. Current state

- One class owns: RPC dispatch and dedupe, mutation transactions and bookkeeping, subscriptions
  (socket index, refresh, backoff, delta framing), presence, the admin/Studio surface, CDC and export,
  alarms (`alarm()` → `this.runner.handleAlarm()`), request logging and metrics.
- Precedent: `plans/467-client-split-remaining-clusters.md` splits `lunora-client.ts` by moving
  free functions that take a narrow host interface instead of `this` (`managed-socket.ts` pattern),
  and keeps the public surface byte-identical (`api:check`).

## 2. Existing seams

- Module-level helpers already outside the class (e.g. `encodeDispatchResult`,
  `subscription-backoff.ts`, the `runner`).
- `api-snapshots/do.api.md` as the public-surface contract.

## 4. Design decisions (to make in workstream 0)

- D1: cluster map — measure members and lines per cluster (subscriptions, admin, CDC/export,
  presence, dispatch) with a script, as plan 467 §1 did.
- D2: host interface per cluster (what each cluster reads/writes on `this`), and whether a cluster
  becomes a free-function module or a collaborator object owned by `ShardDO`.
- D3: order — start with the cluster with the narrowest `this` surface (likely admin/export), never
  the dispatch/transaction core first.

## 5. Workstreams

0. (M) Cluster map + host-interface drafts, recorded here.
1. (L) One cluster per PR; each keeps `api:check` at zero diff, its tests unchanged, the `do` workerd
   project green, and the `do` benches within noise.

## 6. Platform parity

Not applicable (no surface change).

## 7. Gates

Per PR: `api:check` zero diff; `@lunora/do` tests and `workerd` project green; a deliberate break in
the moved code turns a named test red.

## 8. Risks

- **Risk:** single-use forwarding wrappers (more lines, no gain) — the reason 467 needed host
  interfaces. **STOP** a cluster if the move needs more forwarding methods than it removes members.
- **Perf watch:** `packages/do/__bench__` dispatch and subscription benches.

## 9. Open questions

1. Is `create-worker.ts` (7,400 lines) in scope for the same treatment, or a separate plan?
