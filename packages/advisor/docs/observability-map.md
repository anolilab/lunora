# Design: the advisor health map (score + coverage + baseline)

**Status:** phase 1 shipped · **Owner:** advisor

`runAdvisor()` answers _"what is wrong?"_ — a flat `Finding[]`. It cannot answer
_"how are we doing, and did it get worse?"_. This doc designs the layer that can:
a weighted score, a letter grade, a per-procedure coverage rollup, and a
committed baseline a CI gate can diff against.

> **Prior art.** The idea of scoring a codebase this way — "Lighthouse, but for
> your backend" — we took from [evlog](https://github.com/HugoRCD/evlog)'s `map`
> command. The design below is our own: it runs against the `@lunora/codegen`
> feeder rather than a per-framework source scan, and the scoring, vocabulary,
> artifact, and baseline semantics are built for Lunora's lint model.

---

## 1. The gap

The advisor today is splinter-style: each `Lint` is a pure rule over a normalized
`LintContext`; `runAdvisor()` runs a set and flattens the output to a flat
`Finding[]` (level / category / facing / metadata / remediation / stable
`cacheKey`). Evidence comes from the **codegen feeder**, which already extracts
per-procedure and per-schema facts from function bodies — so the advisor needs
**no AST layer of its own**. ~81 static lints plus a 3-lint runtime tier, feeding
the CLI, the Vite plugin, and the Studio Advisors view.

What it has no concept of: a score, a grade, a coverage rollup, or a
baseline/regression artifact. A reviewer can see every finding but cannot see
whether the branch made things better or worse.

## 2. Shape — `scoreAdvisor()` over `runAdvisor()`

Keep `runAdvisor()` exactly as is. Add a thin, **pure** scoring layer that
consumes its `Finding[]` plus the procedure list — it never runs a lint itself,
so no rule is evaluated twice and the lint core is untouched.

- **Entry-point set (the denominator):** `LintContext.procedureProtections`
  (`AdvisorProcedureProtection`) — each row carries `exportName`, `file`, `kind`
  (`query` | `mutation` | `action`), and `visibility` (`public` | `internal`).
  Findings that name no procedure — schema-level ones, and any whose
  `file`/`exportName` matches no declared procedure — roll into a separate
  `project` bucket rather than being dropped.
- **Per-lint weight:** an optional `Lint.weight`, falling back to a severity
  ladder (`ERROR` 20 / `WARN` 10 / `INFO` 5). Deliberately _without_ a "which
  lints participate" marker: every lint family feeds the score today, which is
  why the verdicts are named for severity rather than instrumentation. Such a
  marker becomes relevant only if phase 2 wants a separately-scoped
  observability grade.
- **Rollup:**
    - `scoreProcedure` = 100 − Σ fired-rule weights, held inside `[0, 100]`.
      Charged once per rule, not per occurrence.
    - `scoreGlobal` = weighted mean over non-exempt procedures — public ×2,
      internal ×0.5, `query` ×0.5 with kind winning when both apply — plus the
      project bucket at a weight proportional to the procedure population.
    - `gradeFromScore` → `excellent` (≥90) / `good` (≥70) / `needs-work` (≥50) /
      `at-risk`.
    - Coverage rollup per procedure → `clean` / `warned` / `failing` / `exempt`.
- **Artifact:** `lunora.advisor.map.json` (version, timestamp, per-procedure
  scores + checks, global score + grade, summary tallies) — the baseline unit.
- **Baseline + CI gate:** diff against the committed map; fail on regression or a
  below-threshold score.
- **Studio:** a "Health score" panel — grade + coverage matrix — alongside the
  existing Advisors table, reading the same artifact.

The arithmetic is trivial; the value is in wiring it to feeder facts we already
have.

## 3. What shipped in phase 1

| Piece                                       | Where                              |
| ------------------------------------------- | ---------------------------------- |
| `weight?: number` on `Lint` (advisory)      | `src/types.ts`                     |
| Score/grade/coverage primitives             | `src/map/score.ts`                 |
| `scoreAdvisor()` → `AdvisorMap`             | `src/map/score-advisor.ts`         |
| `compareToBaseline()` / `parseAdvisorMap()` | `src/map/baseline.ts`              |
| Artifact + row types                        | `src/map/types.ts`                 |
| Feeder integration `toAdvisorContext()`     | `@lunora/codegen` `src/advisor.ts` |

Decisions taken while building:

- **A severity ladder, not one flat penalty.** Our lints already carry a
  calibrated `level`, so the fallback weight is keyed on it. An explicit
  `Lint.weight` still overrides.
- **The project bucket counts toward the grade.** Schema debt (missing index,
  circular FK) names no procedure, and excluding it would let an app with a
  wrecked schema and clean handlers grade `excellent`.
- **Scoring is pure and re-reads existing findings**, so the map never
  double-runs a rule.
- **Attribution is `metadata.file` + `metadata.exportName`**, falling back to the
  project bucket rather than dropping a finding.
- **`generatedAt` is caller-supplied**, defaulting to now, so the artifact can be
  made byte-stable.

Decisions taken **after review** (PR #235 — two audit passes plus CodeRabbit):

- **Verdicts named for severity** (`clean`/`warned`/`failing`) rather than
  instrumentation. With every lint family feeding the score, an
  instrumentation-flavoured verdict would have reported a security regression as
  a telemetry gap. Fixing the vocabulary before `MAP_VERSION` ships is cheap; it
  is a breaking artifact change afterwards.
- **Project weight scales with the procedure population** (~1/6 of the grade)
  instead of a flat 1. Measured: with 20 clean procedures, a flat weight let a
  project score of 100 → 80 round away to a **zero** score delta and
  `regressed: false`.
- **`compareToBaseline` gained a fourth signal**, `projectRegressed`, on the
  project bucket's rule count — that bucket's score saturates at 0, after which
  new schema errors moved nothing at all.
- **`BaselineComparison` is a discriminated union.** The flat shape returned
  `regressed: false` for a stale or unreadable baseline, so `if (diff.regressed)`
  silently passed forever after a version bump.
- **`parseAdvisorMap` validates every procedure row** and rejects non-finite
  scores. Previously `procedures: [null]` parsed and then `compareToBaseline`
  threw; `procedures: [{}]` compared as a silent no-op.
- **Weights are normalized** — a negative weight scored 140/100, and a `NaN` one
  serialized to `null`, corrupting the artifact.
- **Checks are deduplicated per rule** (`occurrences` records the count). One
  lint firing on five call sites used to cost 5× and zero a procedure.
- **Sorting uses codepoint order, not `localeCompare`** — the latter reads
  `LANG`/`LC_ALL`, so a Danish-locale runner emitted a different row order and
  churned the committed artifact.
- **`mapSchema()` replaced by `toAdvisorContext()`.** The wrapper re-introduced
  the impurity `scoreAdvisor` exists to avoid, behind a `findings` escape hatch
  nothing could validate against its `options`.
- **Scoring primitives un-exported.** They were public only so tests could reach
  them, which froze arithmetic into the API snapshot; the tests now assert
  through `scoreAdvisor`.

**Known limitation, not fixed here:** nine procedure-local lints —
`filter_without_index` most importantly — emit `metadata.file` without
`exportName`, so they land in the project bucket instead of their procedure's
row. The root cause is upstream (`AdvisorQueryRead` carries no `exportName`);
closing it is a codegen feeder change, tracked as follow-up.

## 4. First observability lints to author (phase 2)

Against existing or lightly-extended feeder facts:

1. **`procedure_without_structured_event`** — a public `mutation`/`action` that
   emits no structured log/event on its primary path (needs a small new feeder
   fact: "handler references the logging/telemetry surface").
2. **`error_without_catalog`** — a thrown/handled error that isn't a
   `LunoraError` / `ERROR_CATALOG` entry (bridge to `@lunora/errors`).
3. **`action_without_error_handling`** — an `action` doing outbound I/O
   (`ctx.fetch` / mail / queue) with no catch/rethrow path.
4. **`ai_run_without_logging`** — reuse `aiRawRuns` / `aiToolSideEffects`; fire
   when a generation has no surrounding observability.

These are advisory (`INFO`/`WARN`), carry a `weight`, and feed the score.

## 5. Phasing

- **Phase 1 — machinery. ✅ shipped.** `scoreAdvisor()` + `weight` on `Lint` +
  coverage rollup + the `AdvisorMap` artifact + `compareToBaseline` /
  `parseAdvisorMap`, reachable from the real feeder via `toAdvisorContext()`. No
  new lints; existing findings seed the weights, so the score is meaningful on
  day one.
- **Phase 2 — observability lints.** Add the §4 family plus the feeder facts they
  need, and close the `exportName` attribution gap above.
- **Phase 3 — Studio panel + CLI surface.** Grade + coverage matrix over the
  artifact; a command that writes `lunora.advisor.map.json` and exposes
  `--min-score` / `--baseline` as a CI gate (the library half of that gate —
  score comparison and regression detection — already exists).

## 6. Open questions

1. ~~Subpath or main entry?~~ **Resolved:** `src/map/*`, re-exported from the
   package index. A separate `@lunora/advisor/map` export would have meant new
   packem/`exports` config for no isolation benefit — `runAdvisor`'s core is
   already untouched because scoring is a pure function over its output.
2. ~~Procedure weights?~~ **Resolved:** public ×2 / internal ×0.5 / query ×0.5,
   with `query` winning when both apply. Still worth tuning against a real app;
   the constants are in one place.
3. **Still open.** Does the codegen feeder run often enough to make the map a
   natural `lunora dev` artifact, or is it an on-demand + CI-only concern? This
   decides the phase-3 CLI surface — `toAdvisorContext()` supports either.
4. **Still open.** Should `exempt` entries be declared in config (a
   `lunora.config` key) or inline in source (a directive comment)? Phase 1 takes
   the list as a caller-supplied option and leaves the source of truth open.
