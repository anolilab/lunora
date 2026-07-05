# Plan 130: [Spike] Inventory how much of the two ctx-db twins is safely shareable

> **Executor instructions**: This is an INVESTIGATE/DESIGN plan — the
> deliverable is a report + design doc, NOT a refactor. Do not modify any
> source file. Follow the steps, honor the STOP conditions, and when done
> update the status row for this plan in `plans/README.md` — unless a reviewer
> dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat b6eb48dcd..HEAD -- packages/do/src/ctx-db.ts packages/sql-store/src/ctx-db.ts`
> Large drift means re-baseline the line counts below before comparing.

## Status

- **Priority**: P3
- **Effort**: L (the spike itself is M; the refactor it scopes would be L–XL)
- **Risk**: n/a for the spike (read-only); the eventual refactor is HIGH risk
  (data-path hot core)
- **Depends on**: none
- **Category**: tech-debt (investigate)
- **Planned at**: commit `b6eb48dcd`, 2026-07-04

## Why this matters

Lunora has two ~3.4k-line `ctx-db` implementations: `packages/do/src/ctx-db.ts`
(3,366 lines — DO SQLite, JSON-blob storage) and
`packages/sql-store/src/ctx-db.ts` (3,492 lines — dialect-parameterized real
columns, backing D1/PlanetScale `.global()` tables). The sql-store file's own
header claims "The query and cursor logic is identical to the DO path", and it
already imports the where-compiler/keyset helpers from `@lunora/do` — but
aggregates, group-by, rank, pagination, and trigger orchestration are
maintained **in parallel**. Concrete evidence of the twin tax: the exact same
`NotUniqueError` throw line exists in both files (`do/ctx-db.ts:1325`,
`sql-store/ctx-db.ts:3180`). Every query-semantics bug fix and every new query
feature is currently implemented twice, and "identical" is enforced only by
discipline. Before anyone attempts an extraction (HIGH risk — a bad one
changes query results), the maintainer needs a factual inventory: what is
byte-parallel, what is genuinely dialect-specific, and what a safe seam looks
like. That inventory is this spike.

## Current state

- `packages/do/src/ctx-db.ts` — 3,366 lines; exports include
  `createShardCtxDb`, `NotUniqueError`, `assertValidClientId`,
  `normalizeIdStructurally` (line 3325).
- `packages/sql-store/src/ctx-db.ts` — 3,492 lines; imports `NotUniqueError`
  (line 69) and where/keyset helpers from `@lunora/do`.
- Dependency direction: `@lunora/sql-store` depends on `@lunora/do`; `do` does
  NOT depend on `sql-store` (verified — no reverse import edge). Consumers of
  sql-store: `d1`, `hyperdrive`, `do`(?), `codegen` — verify with
  `grep -rln '"@lunora/sql-store"' packages/*/package.json`.
- Prior maintainer decisions to respect:
    - The DO JSON-blob path and the drizzle-based sql-store core were kept
      separate deliberately (see the repo's drizzle-rebuild history — the DO
      JSON-blob path was explicitly left untouched).
    - Wave-4 explicitly DEFERRED a `shard-do.ts` god-file split as low-value
      churn; this spike must make the case with data, not aesthetics, or
      recommend REJECTED.
- Existing shared seams to study first: the `WhereSqlStrategy` /
  `compileWhereSql` / keyset helpers that sql-store already imports from
  `@lunora/do` (find them: `grep -n 'from "@lunora/do"' packages/sql-store/src/ctx-db.ts`).
- Test assets that would gate a future refactor: `packages/do/__tests__/`
  (~990 tests, heavy ctx-db coverage), `packages/sql-store/__tests__/`
  (~10 direct tests — thin), `packages/d1/__tests__/` (21 files exercising
  the D1 dialect end-to-end; being wired into CI by plan 121).

## Commands you will need

| Purpose            | Command                                                                                 | Expected on success               |
| ------------------ | --------------------------------------------------------------------------------------- | --------------------------------- |
| Similarity scan    | `git diff --no-index --stat packages/do/src/ctx-db.ts packages/sql-store/src/ctx-db.ts` | a diffstat (big, but informative) |
| Function inventory | `grep -n '^const \|^export const \|^function \|    private \|    public ' <file>`       | symbol lists                      |
| Import edges       | `grep -n 'from "@lunora/do"' packages/sql-store/src/ctx-db.ts`                          | current shared seam               |

## Scope

**In scope** (deliverables — files to CREATE only):

- `plans/130-phase0-design.md` — the inventory + recommendation

**Out of scope**:

- ANY modification to `packages/do` or `packages/sql-store` source or tests.
- Prototyping the extraction in-tree (a throwaway worktree prototype is
  allowed only if explicitly requested later).

## Git workflow

- Branch: `advisor/130-ctx-db-twins-spike` (docs-only commit)
- Suggested commit: `docs(plans): ctx-db twins shareability inventory (plan 130)`.

## Steps

### Step 1: Build the method-level parallelism map

For each public surface of the two files (reader: get/query/unique/first/
collect/paginate/aggregate/groupBy/rank/search; writer: insert/patch/replace/
delete/insertMany/patchMany/deleteMany/upsert; plus trigger orchestration and
cursor encode/decode): classify as

- **P (parallel)** — same algorithm, differing only in row materialization
  (json_extract vs columns) or exec dialect;
- **D (dialect-specific)** — genuinely different logic;
- **S (already shared)** — delegates to the `@lunora/do` helpers.

Method-by-method table with line ranges in both files. Estimate parallel LOC.

### Step 2: Characterize the seam

For the P set, identify what a shared core would need injected: the row
codec (JSON-blob vs column mapping), the exec/prepare interface, identifier
quoting, transaction/OCC hooks, trigger dispatch. Compare against the
existing `WhereSqlStrategy` seam — is the extraction "more of the same
strategy pattern" or does it need a new abstraction? Name the package where
the core would live (candidate: `@lunora/sql-store` core consumed by `do`,
which INVERTS the current dependency direction — analyze whether that
inversion is acceptable or whether a third package/`shared/` layer is needed;
note `shared/` requires zero-dependency files, which a query core with
`@lunora/values` types likely violates).

### Step 3: Risk & payoff assessment

- Payoff: measured parallel LOC × recent churn (`git log --oneline -20 -- <each file>`
  — how often do changes land in BOTH files for one feature?). Find ≥2
  concrete commits that had to touch both files for one logical change (or
  record that none exist — that would weaken the case).
- Risk: enumerate behavior cliffs (cursor format stability, OCC/trigger
  ordering, NaN/undefined encode edge cases) and the test coverage that does
  / does not pin them (sql-store's thin 10-test direct suite is the gap —
  quantify what characterization tests the refactor would need first).

### Step 4: Recommendation

One of:

- **REFACTOR (phased)** — with the seam design, package layout, a
  characterization-tests-first phase list, and effort per phase; or
- **REJECT / STATUS QUO+** — if parallel LOC or churn is low, recommend
  documented discipline instead (e.g. a comment-anchored checklist in both
  file headers listing the methods that must be edited in tandem), which is
  cheap and honest.

Write it all into `plans/130-phase0-design.md` with the tables from Steps 1–3.

**Verify**: the design doc exists, contains the method table, the ≥2-commit
churn evidence (or its absence), and an unambiguous recommendation.

## Test plan

n/a (read-only spike). The design doc must SPECIFY the characterization-test
prerequisites for any recommended refactor.

## Done criteria

- [ ] `plans/130-phase0-design.md` exists with: method-level P/D/S table,
      parallel-LOC estimate, seam design (or rejection), churn evidence,
      risk list, phased plan or REJECT verdict
- [ ] Zero source files modified (`git status` shows only the new doc)
- [ ] `plans/README.md` status row updated (SPIKE DONE + one-line verdict)

## STOP conditions

Stop and report back (do not improvise) if:

- Either file has been split/moved since `b6eb48dcd` (re-baseline first).
- You find yourself prototyping the refactor instead of measuring — the
  deliverable is the inventory.

## Maintenance notes

- If the verdict is REFACTOR, the follow-up plans must sequence:
  characterization tests (sql-store + d1, leaning on plan 121's CI wiring) →
  seam extraction → dual-backend conformance suite.
- If REJECT, add the tandem-edit checklist to both file headers in a tiny
  follow-up docs commit (note it in the index).
