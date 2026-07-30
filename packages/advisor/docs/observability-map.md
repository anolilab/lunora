# Design: an observability "map" (score + coverage + baseline) for `@lunora/advisor`

**Status:** proposal · **Owner:** advisor · **Prior art:** [`evlog map`](https://github.com/HugoRCD/evlog) (`@evlog/cli`)

This doc evaluates porting the [`evlog map`](https://www.evlog.dev/cli/map) command into
`@lunora/advisor` and proposes a Lunora-native shape. The short version: port the
**scoring / coverage-map / baseline machinery** (it is genuinely new capability the
advisor lacks), and author a small **`observability` lint family** against the
existing codegen feeder rather than lifting evlog's framework adapters and
wide-event rules (which are tied to evlog's API and would duplicate work the feeder
already does).

---

## 1. What `evlog map` is

`evlog map` is "Lighthouse for observability" — a deterministic static scan that
scores how well an app instruments its entry points with wide events, and gates CI
on that score. It is **not** a pass/fail linter; its output is a graded coverage map.

Pipeline (`packages/cli/src/lib/map/` in `HugoRCD/evlog`):

1. **Framework adapters** (`nuxt` / `nitro` / `next` / `tanstack-start`) glob entry
   points — `adapter.extractRoutes(ctx)`.
2. Each file is parsed with **`oxc-parser`** behind a shared parse cache.
3. Each route is classified by **sensitivity** first (this gates the `audit` rule),
   then run through **rules** that each emit a `CheckResult`
   (`pass` | `fail` | `n/a`, with evidence and directive/exemption suppression).
   Rules: `wide-event`, `context`, `structured-errors`, `audit`, `audit-coverage`,
   `error-handling`, `page-error-handling`, `error-catalog`, `ai-logging`,
   `auth-identity`.
4. **Scoring** (`score.ts`):
   - `scoreRoute` starts at 100 and subtracts each failed rule's weight (fallback
     10, clamped ≥ 0).
   - `scoreGlobal` = weighted average excluding `exempt` routes — high-sensitivity
     handlers ×2, pages ×0.5, default ×1.
   - `gradeFromScore` → `excellent` (≥ 90) / `good` (≥ 70) / `needs-work` (≥ 50) /
     `at-risk`.
5. **Output**: writes `evlog.map.json`; routes roll up as
   `instrumented` / `partial` / `dark` / `exempt`. Flags: `--baseline [ref]` diffs
   against the committed map to catch regressions, `--min-score <n>` exits non-zero
   as a CI gate, `--all` renders a per-directory check matrix, `--no-write`,
   `--json`, `--framework <name>`.

## 2. What the advisor is today

Splinter-style lints: each `Lint` is a pure rule over a normalized `LintContext`;
`runAdvisor()` runs a set and flattens their output to a flat `Finding[]`
(level / category / facing / metadata / remediation / stable `cacheKey`). Evidence
comes from the **codegen feeder**, which already extracts per-procedure and
per-schema facts from function bodies — so the advisor needs **no AST layer of its
own**. ~81 static lints + a 3-lint runtime tier. Feeds the CLI, the Vite plugin, and
the Studio Advisors view.

Confirmed gaps (grepped): **no** score/grade concept, **no** coverage rollup, **no**
baseline/regression artifact, **no** observability/logging lints.

## 3. Fit and the two separable pieces

| | `evlog map` | `@lunora/advisor` |
| --- | --- | --- |
| Model | scored **coverage map** over entry points | flat **`Finding[]`** over a `LintContext` |
| Evidence | own per-framework `oxc-parser` scan | central **codegen feeder** facts |
| Output | score + grade + map file + baseline + matrix | boolean findings, no score/coverage |
| Rules | evlog wide-event API | Lunora schema/security/perf |

The port splits cleanly:

- **(A) The machinery** — score, grade, coverage rollup, baseline regression,
  `--min-score`. This is the reusable, high-value idea the advisor lacks. It layers
  **on top of** `runAdvisor` without touching any existing lint.
- **(B) The rules** — mostly a rewrite. evlog's checks target its `useEvent` /
  wide-event API. The Lunora equivalents either already exist or map to Lunora
  primitives, and their evidence is already in the feeder:

  | evlog rule | Lunora equivalent | feeder input |
  | --- | --- | --- |
  | `error-catalog` | `@lunora/errors` `ERROR_CATALOG` | (exists) |
  | `ai-logging` | `@lunora/ai` raw runs | `aiRawRuns`, `aiToolSideEffects` |
  | `auth-identity` | `ctx.auth` identity reads | `identityClaimReads`, `procedureProtections` |
  | `wide-event` / `context` / `structured-errors` / `error-handling` | **new** Lunora instrumentation-coverage lints over procedure bodies | new feeder facts (see §5) |

We do **not** need evlog's framework adapters: Lunora *is* the framework, and the
entry-point set is already enumerated by the feeder as procedures.

## 4. Proposed shape — `scoreAdvisor()` over `runAdvisor()`

Keep `runAdvisor()` exactly as is. Add a thin, pure scoring layer that consumes its
`Finding[]` plus the procedure list.

- **Entry-point set (the denominator):** `LintContext.procedureProtections`
  (`AdvisorProcedureProtection`) is the natural "route" analog — each carries
  `exportName`, `file`, `kind` (`query` | `mutation` | `action`), and `visibility`
  (`public` | `internal`). Schema-level findings (no procedure) roll into a separate
  `schema` bucket.
- **Per-lint weight + observability opt-in:** extend the `Lint` metadata with an
  optional `weight` (default 10, mirroring evlog's fallback) and a marker for which
  lints participate in the observability score, so security/perf lints keep flowing
  to the Advisors table unchanged while only the instrumentation family drives the
  grade.
- **Rollup (mirrors evlog `score.ts`):**
  - `scoreProcedure(findings)` = 100 − Σ failed-lint weights, clamped ≥ 0.
  - `scoreGlobal` = weighted mean over non-exempt procedures — weight public
    handlers ↑, internal ↓ (Lunora analog of evlog's high-sensitivity ×2 / page
    ×0.5).
  - `gradeFromScore` → reuse evlog's `excellent`/`good`/`needs-work`/`at-risk` bands.
  - Coverage rollup per procedure → `instrumented` / `partial` / `dark` / `exempt`.
- **Artifact:** write `lunora.advisor.map.json` (version, timestamp, per-procedure
  scores + checks, global score + grade, summary tallies) — the baseline unit.
- **Baseline + CI gate:** `--baseline [ref]` diffs against the committed map;
  `--min-score <n>` exits non-zero. Surfaced through the existing `lunora`
  CLI/advisor entry, not a new binary.
- **Studio:** a new "Observability / Health score" panel — grade + coverage matrix —
  alongside the existing Advisors table, reading the same artifact.

Everything above is small: evlog's `score.ts` is trivial arithmetic; the value is in
wiring it to feeder facts we already have.

## 5. First observability lints to author (piece B, phase 2)

Against existing or lightly-extended feeder facts:

1. **`procedure_without_structured_event`** — a public `mutation`/`action` that emits
   no structured log/event on its primary path (needs a small new feeder fact:
   "handler references the logging/telemetry surface").
2. **`error_without_catalog`** — a thrown/handled error that isn't a `LunoraError` /
   `ERROR_CATALOG` entry (bridge to `@lunora/errors`).
3. **`action_without_error_handling`** — an `action` doing outbound I/O
   (`ctx.fetch` / mail / queue) with no catch/rethrow path.
4. **`ai_run_without_logging`** — reuse `aiRawRuns` / `aiToolSideEffects`; fire when a
   generation has no surrounding observability.

These are advisory (`INFO`/`WARN`), carry a `weight`, and feed the score.

## 6. Recommendation & phasing

Port the **machinery**, author the **rules** natively.

- **Phase 1 — machinery.** `scoreAdvisor()` + `weight` on `Lint` + coverage rollup +
  `lunora.advisor.map.json` + `--min-score` / `--baseline`. No new lints; existing
  security/perf findings can seed weights so the score is meaningful on day one.
- **Phase 2 — observability lints.** Add the §5 family + the one or two new feeder
  facts they need.
- **Phase 3 — Studio panel.** Grade + coverage matrix over the artifact.

## 7. Licensing / attribution

`evlog` is FSL-1.1-Apache-2.0; `@lunora/advisor` is FSL-1.1-Apache-2.0 — compatible.
We are porting *ideas and the scoring formula*, not lifting source (the framework
adapters and rule bodies are rewritten against the feeder). Credit `evlog map` as
prior art in the code and this doc regardless.

## 8. Open questions

1. Should the observability score live **inside** `@lunora/advisor` or in a thin
   `@lunora/advisor/map` subpath, to keep `runAdvisor`'s pure-lint core untouched?
2. Weighting for `public` vs `internal` vs `query` procedures — start with
   public ×2 / internal ×0.5 / query ×0.5 and tune against a real app.
3. Does the codegen feeder run often enough to make the map a natural `lunora dev`
   artifact, or is it a `lunora advisor --map` on-demand + CI-only concern?
