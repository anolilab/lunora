# Implementation Plans

Advisor plan waves run against this repo. **Completed plans are removed from this
directory once shipped** (the record lives in git history and the tables below);
only deferred, blocked, or reference plans remain as files.

Status values: TODO | IN PROGRESS | DONE | BLOCKED (one-line reason) | REJECTED.

## Wave 1 — Cloudflare platform coverage (baseline `058071c8`, 2026-06-15)

Does lunora support a given Cloudflare product/binding? The 14 completed plans
(027–032, 034, 035, 038–043) shipped and were removed. Remaining (all P3, deferred):

| Plan | Cloudflare product        | Shape                                  | Status              |
| ---- | ------------------------- | -------------------------------------- | ------------------- |
| 033  | Stream (video)            | `@lunora/stream` (REST + signed URLs)  | TODO (P3, deferred) |
| 036  | Pipelines                 | hint-binding + `ctx` send helper       | TODO (P3, deferred) |
| 037  | Realtime / Calls (WebRTC) | optional TURN/SFU helper (out-of-core) | TODO (P3, deferred) |

## Wave 2 — all-package gaps + end-to-end DX (baseline `b51b440a`, 2026-06-17)

Audit of what's missing across the 37 packages and how to improve the DX of the
full product. Executed via isolated-worktree subagents; each was reviewed
(build/test/typecheck re-run) before landing on `alpha`.

| Plan | Title                                             | Status                                                                                                                                                                                                                                                                  |
| ---- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 044  | Docs/AGENTS.md package coverage                   | DONE (shipped)                                                                                                                                                                                                                                                          |
| 045  | Testing-harness coverage (scheduler/fetch/subs)   | DONE (shipped)                                                                                                                                                                                                                                                          |
| 046  | Shared pagination core in `@lunora/client`        | DONE (shipped, folded into 047)                                                                                                                                                                                                                                         |
| 047  | Vue/Solid/Svelte adapter parity with React        | DONE (shipped)                                                                                                                                                                                                                                                          |
| 048  | Inner-loop error-UX papercuts                     | DONE (shipped)                                                                                                                                                                                                                                                          |
| 049  | MCP function-schema introspection tool            | DONE (shipped)                                                                                                                                                                                                                                                          |
| 050  | Expand advisor runtime lints                      | REJECTED & REMOVED — the two proposed lints already exist as the two halves of the existing `index_utilization` runtime lint. Plan file deleted; record in git history.                                                                                                 |
| 051  | Thread project version into OpenAPI/OpenRPC specs | DONE (shipped)                                                                                                                                                                                                                                                          |
| 052  | [Spike] Typed HTTP-SSE stream consumer            | REWRITTEN — original WS premise was wrong (`use-stream.ts` already consumes WS `kind:"stream"`); real gap is a typed consumer for `httpRoute.<verb>().stream()` SSE routes. See [052-streaming-hook-spike.md](052-streaming-hook-spike.md) (TODO, P2).                  |
| 053  | Batch mutations (insertMany/deleteMany/patchMany) | BUILD IMPLEMENTED (pending commit/review) — all three on `DatabaseWriter` per the §8 decisions (Q1 all-or-nothing, Q5 cap 500); tests green. Design doc removed; record in git history.                                                                                 |
| 054  | Package-aware `.dev.vars` secrets scaffolding     | DONE (shipped)                                                                                                                                                                                                                                                          |
| 055  | Workflows & Queue observability in Studio         | DONE & REMOVED — workflows REST proxy + studio instance history and scheduler dead-letter + workpool observability both shipped; Queues migration analyzed and rejected (the two workpool backends coexist by design). Record in git history.                           |
| 056  | Resolve `node_modules` schema extensions          | DONE & REMOVED — codegen runtime-introspects `.extend(pkg.extension)` from a published package (sync `require(esm)` from the project root → bare `TableIR`; fail-safe to warn+skip; handles named/default/namespace imports). Plan file deleted; record in git history. |

### Notes

- **046** was cherry-picked into **047**'s branch, so the shared pagination core
  and the adapter parity work shipped together in one commit on `alpha`.
- **048 ↔ 054** both touched `cli/src/commands/dev/handler.ts`
  (`offerDevVariablesScaffold`); the two changes were merged by hand on integration.
- **052** rewritten: the genuine gap is a typed consumer for HTTP-SSE
  `httpRoute.<verb>().stream()` routes — codegen captures `HttpRouteIR.stream` but
  emits no typed reference, and the client has no SSE reader. The plan now targets
  that (codegen-emitted `HttpStreamRef` + a fetch/`ReadableStream` consumer + hook).
- **053** shipped its design doc only; the public-`DatabaseWriter` prototype was
  held out of `alpha` pending maintainer sign-off (§8 carries recommended answers
  for the 5 open questions: RLS partial-failure policy, the `lunoraTest`
  BEGIN/COMMIT gap, return shape, …).

## Wave 3 — developer-experience pass (baseline `55d2b166`, 2026-06-26)

Focused DX audit (CLI, Vite plugin, codegen diagnostics, error messages,
onboarding, inner loop). All seven selected plans shipped to the working tree and
were verified before the plan files were removed. Code plans executed via
isolated-worktree subagents, each reviewed (build/test/typecheck/lint re-run in
the main tree) before integration: `@lunora/codegen` 363/363, `@lunora/cli`
512/512, both `lint:types` + `eslint` clean, docs Prettier-clean.

| Plan | Title                                                 | Status                                                                                                                                                                                                                                                                                                  |
| ---- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 057  | CONTRIBUTING states correct pnpm/Node versions        | DONE & REMOVED — `CONTRIBUTING.md` now matches `package.json` (pnpm `11.5.3`, Node `^22.15.0 \|\| >=24.11.0`); the stale `10.32.1` / `^22.14.0` are gone.                                                                                                                                               |
| 058  | Cron/migration codegen errors carry file:line         | DONE & REMOVED — 10 cron throw-sites + 1 migration site wrapped with `diagnosticAt` (clickable Vite overlay, matching the schema/container tier); `code`/`name`/`status` metadata preserved; regression test added. Cross-file duplicate-collision sites left location-less by design (no single node). |
| 059  | Playground "Local dev" docs cover env setup           | DONE & REMOVED — README now instructs copying `.dev.vars.example`, names the `AUTH_SECRET is required` failure, and clarifies local-vs-deploy D1.                                                                                                                                                       |
| 060  | `lunora init` download failures are actionable        | DONE & REMOVED — exported `describeDownloadFailure` classifies offline/404/unknown and prints `--from`/`--ref` next steps; 3 unit tests.                                                                                                                                                                |
| 061  | Cancelling a prompt exits cleanly                     | DONE & REMOVED — the shared `defineHandler` wrapper now exits `130` without a red error line when `error.name === "PromptCancelledError"` (name-based check, no Ink pulled into the universal wrapper); 3 unit tests.                                                                                   |
| 062  | `lunora add` supports `--format json`                 | DONE & REMOVED — `add` now mirrors `verify`'s `--format pretty\|json` (validate → `loggerForFormat` → `printJson({ code, items })`); 2 unit tests. `registry add`'s existing `--json` boolean left as-is (normalizing it is a separate, possibly-breaking change).                                      |
| 063  | [Spike] Codegen timing + incremental-discovery design | DONE & REMOVED — shipped opt-in `LUNORA_CODEGEN_TIMING` instrumentation (discovery/emit split) + side-effect-free guard test. **Verdict on incremental discovery: NOT worth it now** — see below.                                                                                                       |

### Notes

- **057 & 059** were trivial docs and applied directly in the main tree (not via
  a subagent); **058+063** ran in one codegen worktree, **060+061+062** in one CLI
  worktree (grouped by package to minimize install overhead).
- **Commit-type drift surfaced:** the repo's enforced commitlint type-enum
  (`build, chore, ci, deps, docs, feat, fix, perf, refactor, revert, security,
style, test, translation`) does **not** include `dx`, even though `CLAUDE.md`
  lists `dx` as an allowed type. Executors used `fix`/`feat`/`perf` instead.
  Worth reconciling `CLAUDE.md` with the commitlint config (or adding `dx` to the
  config).
- **063 incremental-discovery assessment (measured against `apps/playground`,
  `LUNORA_CODEGEN_TIMING=1`):** the warm Vite dev-loop (reused ts-morph Project +
  `refreshCodegenProject`) runs codegen in **~18–20ms** steady-state (discovery
  ~18ms, emit ~0ms). The only slow path is the fresh-Project CLI one-shot
  (~900ms), and **~80–95% of that is ts-morph Project construction / type-loading**
  — which incremental _discovery_ would not touch. Global passes
  (`discoverSchema`, `discoverFeatureUsage`, cross-file uniqueness/cron-target
  resolution) can't be skipped on a single-file change anyway, and changed-file-only
  emit carries real staleness risk. Recommendation: keep the timing line as the
  measurement; if fresh-run latency ever matters, pursue **Project/type-program
  reuse for the CLI one-shot**, not incremental discovery.

## Findings considered and rejected (Wave 3)

- **Stale-`dist/` inner-loop trap** — no longer actionable. `vis.config.ts`
  declares `dependsOn: ["^build"]` on `test`/`test:coverage`/type-aware targets,
  so the vis-orchestrated path builds deps; the vis task-cache-masking bug was
  fixed upstream (`@visulima/vis` `1.0.0-alpha.43`). What remains (raw
  `pnpm --filter X test` bypassing vis) is inherent to pnpm filtering, not a
  defect, and is documented in `CLAUDE.md`.
- **`vis generate --name value` space-form misparse** and **vis `parallel`×vitest
  oversubscription** — real, but upstream `@visulima/vis` issues tracked in
  `VIS-ISSUES.md`; fixed upstream on vis's alpha. Not fixable inside this repo.
- **Structured exit-code enum for the CLI** — no consumer parses specific codes
  today; speculative.
- **`project.json` references a nonexistent root `eslint.config.js`** — LOW
  confidence; the actual `lint:eslint` script runs `eslint .` (per-package config),
  so the `project.json` `command`/`inputs` field is stale metadata rather than
  broken. Investigate-only; not planned.
- **#8 — merge-conflict markers in this file** — resolved while writing this
  index (took the most-advanced resolution: 056 DONE & REMOVED).

## Notes for executors (carried from prior waves)

- `dist/` is gitignored and built on demand. Build deps first:
  `pnpm --filter "@lunora/<pkg>..." run build` (trailing `...` includes deps), or
  `pnpm run build:packages` once, or `pnpm run test:affected` / `lint:affected:types`.
  In a fresh worktree the `...`-filter may not expand transitively before dist
  exists — `pnpm run build:packages` is the reliable fallback.
- ESM with `moduleResolution: "bundler"` — **no `.js` extensions** in relative
  imports (sole exception: `@lunora/codegen`'s emitted `_generated/*` output).
- Never mix a default export with named exports; named-only when a file has >1 export.
- Shared dep versions come from pnpm catalogs (`catalog:*`) — never hardcode a version.
- Enforced commit types differ from `CLAUDE.md` — see the Wave 3 note above.
