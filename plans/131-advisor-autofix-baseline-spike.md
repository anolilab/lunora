# Plan 131: [Spike] Design advisor autofix + suppression/baseline so 80 lints stay enabled on brownfield apps

> **Executor instructions**: This is a DESIGN/SPIKE plan — the deliverable is
> a design doc plus a small throwaway prototype, NOT a shipped feature. Follow
> the steps, honor the STOP conditions, and when done update the status row
> for this plan in `plans/README.md` — unless a reviewer dispatched you and
> told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat b6eb48dcd..HEAD -- packages/advisor/src packages/codegen/src/ir.ts`
> Significant advisor restructuring since `b6eb48dcd` (e.g. plan 125's
> factories) is fine — read the live shapes; the finding contract below is
> what matters.

## Status

- **Priority**: P2
- **Effort**: L (spike itself: M — a design doc + prototype of ONE fixer and
  ONE suppression path)
- **Risk**: MED for the eventual feature (autofixing user schema files must be
  conservative); the spike is low-risk
- **Depends on**: none (coordinate with plans 124/125 if executing
  concurrently — same package)
- **Category**: direction (dx)
- **Planned at**: commit `b6eb48dcd`, 2026-07-04

## Why this matters

The advisor now ships ~80 static lints (schema shape, query usage, and a
large security family) plus runtime lints, surfaced in the CLI, the Vite
overlay, and Studio. Every finding carries structured `metadata`
(file/line/exportName), a `remediation` string, `docsUrl`, and a stable
`cacheKey`. What ships **nowhere** is a way to act on or acknowledge a
finding: there is no autofix/code-action, and no user-facing suppression or
baseline (`grep -rn "suppress\|baseline\|ignore" packages/advisor/src` hits
only internal lint self-gating and Studio hot-scan dedup). The predictable
brownfield outcome: a team adopting Lunora on an existing app meets a wall of
dozens of findings they can neither fix-in-place nor acknowledge, and turns
the advisor off — wasting the repo's single biggest safety investment. Linters
that survive are the ones with `--fix` and a baseline story (ESLint,
Ruff, splinter). The structured findings already carry everything a fixer and
a baseline need; this spike designs both and proves each with a prototype.

## Current state

- Finding contract (`packages/advisor/src/finding.ts` — the `emit` helper):
  every finding = `{ cacheKey, categories, description, detail, facing,
level, metadata, name, remediation, title }`, with `cacheKey` formats like
  `"kv_unscoped_user_key_idor:<file>:<line>"` or
  `"public_mutation_without_ratelimit:<file>:<exportName>"` — **note: some
  embed line numbers (drift-sensitive), some embed export names (stable)**;
  this asymmetry is a core baseline-design constraint.
- Lint registry: `packages/advisor/src/lints/static/*.ts` (~80 files, each a
  default-exported `Lint` with `run(context) → Finding[]`), runtime lints
  under `lints/runtime/`.
- Mechanical-fix candidates (verify each lint's semantics before listing in
  the design): unindexed-FK (add an index to `defineSchema`),
  duplicate/empty index (remove), missing `.rls(...)`/`.public()` markers,
  ratelimit-middleware wiring, `.max()` on unbounded string args — roughly
  the "schema shape" family. Security lints (IDOR/SQL-injection) are
  advisory-only: their fixes change semantics — NOT autofix candidates.
- Surfaces that would host the actions: `@lunora/cli` (an
  `lunora advisor --fix`-style command — check the actual advisor CLI entry:
  `grep -rn "advisor" packages/cli/src/commands/`), the Studio Advisors pages
  (`packages/studio/src/features/advisors/`), and the Vite overlay.
- AST-edit machinery already in the repo: `ts-morph` is a codegen dependency,
  and `vis generate lunora-table` already **AST-merges into `lunora/schema.ts`**
  — i.e. the repo has precedent + tooling for safe schema-file edits (see
  `.vis/templates/lunora-table.ts` for how it merges).
- Formatting invariant: user files are Prettier-formatted; any fixer output
  must be Prettier-stable (run the project's Prettier after edits or emit
  already-formatted code).

## Commands you will need

| Purpose                  | Command                                    | Expected on success                      |
| ------------------------ | ------------------------------------------ | ---------------------------------------- |
| Advisor tests            | `pnpm --filter "@lunora/advisor" run test` | all pass (prototype must not break them) |
| Playground as guinea pig | inspect `apps/playground/lunora/schema.ts` | a real schema to fix against             |

## Scope

**In scope** (deliverables):

- `plans/131-phase0-design.md` — the design doc
- A prototype branch demonstrating: (1) ONE working fixer end-to-end on
  `apps/playground` (e.g. unindexed-FK → index added to `schema.ts`,
  Prettier-clean, advisor re-run shows the finding gone), and (2) ONE working
  suppression path (finding acknowledged → excluded from output with an
  audit trail). Prototype code may live under `packages/advisor/src/` behind
  no exports OR in `__tests__` fixtures — it is throwaway; mark it clearly.

**Out of scope**:

- Shipping the feature (follow-up plans do that).
- Autofix for any security lint.
- Studio UI implementation (the design doc specifies it; no React work).

## Git workflow

- Branch: `advisor/131-autofix-baseline-spike`
- Commit the design doc as `docs(plans): advisor autofix+baseline design (plan 131)`;
  prototype commits stay on the branch (never merged as-is).

## Steps

### Step 1: Classify all ~80 lints for fixability

Read every lint (or, post-plan-125, every factory config) and classify:
**AUTOFIX-SAFE** (mechanical, semantics-preserving), **ASSISTED** (fix needs
one user decision — e.g. which field to index), **ADVISORY-ONLY** (semantic /
security). Produce the table with the fix shape per AUTOFIX-SAFE lint (which
file it edits, what AST operation).

### Step 2: Design the fixer architecture

Decide and document:

- Where fixes live: a `fix?: (finding, project) => FileEdit[]` member on the
  `Lint` type vs a separate fixer registry keyed by lint name (recommend one;
  consider that `Lint.run` operates on the pre-built `LintContext`, not the
  AST — fixers need the ts-morph project, which lives in codegen → likely a
  **codegen-side fixer registry** consuming advisor findings; analyze the
  package-boundary options).
- Idempotence + conflict rules (two findings editing the same node).
- The invocation surface: CLI flag(s), exit codes, dry-run diff output.
- Prettier/format guarantee.

### Step 3: Design suppression + baseline

- **Inline suppression**: a comment directive (e.g. `// lunora-ignore <lint-name> -- reason`)
  — specify how static lints (which run on codegen IR, not raw source) learn
  about it: the feeder must capture directives into the IR (a codegen
  change — scope it).
- **Baseline file**: e.g. `lunora/advisor-baseline.json` keyed by `cacheKey`
  — analyze the cacheKey-stability problem (line-number keys churn on
  unrelated edits; design a stabilization: normalize keys to
  `name:file:exportName` where possible, or store a content hash of the
  finding site). Specify baseline lifecycle: generate (`--update-baseline`),
  expiry/ratchet (baselined findings warn at lower level, never ERROR-fail),
  and how Studio renders baselined-vs-live.
- Precedence rules (inline beats baseline; security lints may require a
  `reason`).

### Step 4: Prototype the two proofs

1. Fixer proof: unindexed-FK (or the easiest AUTOFIX-SAFE lint from Step 1)
   against `apps/playground` — before/after diff + advisor re-run in the doc.
2. Suppression proof: baseline file honored by `runAdvisor` (a context filter
   is likely sufficient for the prototype).

**Verify**: both proofs reproduce from the doc's commands; existing advisor
tests still pass on the prototype branch.

### Step 5: Write `plans/131-phase0-design.md`

Contents: the Step-1 table, architecture decisions with alternatives
considered, the cacheKey-stability design, rollout phases (suggested: baseline
first — it's what stops brownfield abandonment — then fixers for the top ~10
mechanical lints), effort estimates per phase, and open questions for the
maintainer (e.g. should `--fix` be part of `lunora dev`'s loop or manual-only?).

## Test plan

Spike-level: the two proofs + green existing suites. The design doc must
specify the real test matrix for the shipped feature (fixer idempotence,
baseline ratchet, directive parsing).

## Done criteria

- [ ] `plans/131-phase0-design.md` exists with the classification table
      (all ~80 lints), both architectures, cacheKey-stability design, phased
      rollout, open questions
- [ ] Fixer proof: playground diff + "finding gone on re-run" evidence in the doc
- [ ] Suppression proof: baseline honored, evidence in the doc
- [ ] `pnpm --filter "@lunora/advisor" run test` green on the prototype branch
- [ ] `plans/README.md` status row updated (SPIKE DONE + one-line recommendation)

## STOP conditions

Stop and report back (do not improvise) if:

- Fewer than ~5 lints classify AUTOFIX-SAFE (the autofix half would be
  over-engineering — recommend baseline-only and say so).
- The directive design requires codegen IR changes that would break the
  golden fixtures in more than a trivial way — note the cost, don't build it.
- You find an existing suppression mechanism the audit missed (grep again
  around `facing`/`level` filtering in CLI/studio config) — incorporate it
  instead of designing a rival.

## Maintenance notes

- The baseline keyed on stabilized cacheKeys becomes a public contract —
  lint cacheKey format changes after shipping will orphan baselines; the
  design must state the compatibility rule.
- Coordinate with plan 125 (factories) — fixer configs slot naturally into
  the same factory configs.
