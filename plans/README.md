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

## Wave 4 — local-first sync engine hardening (baseline `9f779358`, 2026-06-29)

Audit focused on the new local-first sync engine (PR #37: `defineShape` /
`defineMutator`, the op-log + poke protocol, per-client watermarks, the
TanStack-DB collections + durable outbox) plus the DO/runtime hot paths it added.
Standard effort, ≤4 concurrent Explore agents. All findings were vetted against
live code before planning; excerpts in each plan are from first-hand reads at
`9f779358`. **None executed yet — all TODO.**

Selected bundles (user choice): security + quick perf wins, correctness fixes,
sync-engine characterization tests, larger perf + refactor.

| Plan | Title                                                          | Category  | Pri | Effort | Risk | Status |
| ---- | -------------------------------------------------------------- | --------- | --- | ------ | ---- | ------ |
| 064  | Redact raw `error.message` in DO RPC error fall-through        | security  | P1  | S      | LOW  | TODO   |
| 065  | Keyed optimistic subscription fan-out (drop triple-match loop) | perf      | P1  | S      | LOW  | TODO   |
| 066  | Cache synced-row JSON in `@lunora/db` diff-emit                | perf      | P1  | S      | LOW  | TODO   |
| 067  | Grouped relation count (kill N+1 in `resolveCounts`)           | perf      | P2  | M      | MED  | TODO   |
| 068  | Fix list optimistic overlay hang on unchanged mutator result   | bug       | P1  | M      | MED  | TODO   |
| 069  | Tests: client shape re-seed on epoch fork / base divergence    | tests     | P2  | S      | LOW  | TODO   |
| 070  | Tests: server shape resume-vs-reseed matrix                    | tests     | P2  | M      | LOW  | TODO   |
| 071  | Tests: mutator handler-failure watermark self-healing          | tests     | P2  | M      | LOW  | TODO   |
| 072  | Share op-log read across shape pokes in one flush              | perf      | P2  | M      | MED  | TODO   |
| 073  | Dedup identity-independent reactive query runs across sockets  | perf      | P2  | M      | MED  | TODO   |
| 074  | Extract shared socket-pool helper (dedup poke worker pools)    | tech-debt | P3  | S      | LOW  | TODO   |

### Recommended execution order & dependencies

- **First, the quick wins (no deps):** 064, 065, 066 — small, isolated,
  high-leverage. Land them in any order.
- **Correctness:** 068 is a P1 bug in the headline feature, but MED-confidence and
  design-y — written **test-first** with a STOP condition if the fix needs a
  server protocol change. No hard dep, but do it deliberately.
- **Tests before the refactors they protect:** 069/070/071 stand alone and should
  land before the perf work on the same paths. Specifically **070 → 072** (the
  resume/diff matrix is the safety net for the op-log read-sharing change).
- **Larger perf:** 067 (cross-backend, raise scope carefully), 072 (after 070),
  073 (sharp RLS/security boundary — STOP if no static identity-independence
  signal exists).
- **Last:** 074 (the socket-pool helper extraction) — depends on 072 and 073
  having reshaped `pokeShapeSubscribers` / `refreshSubscriptions` first, so it
  consolidates the final duplicated worker-pool boilerplate rather than churning
  twice.

### Notes

- **068, 073** carry hard STOP conditions because each has a correctness/security
  cliff (a server-protocol change, and cross-identity result sharing
  respectively). An executor that hits the cliff must report, not improvise.
- **074** was filed but is the lowest priority — it's pure boilerplate dedup
  (`runSocketPool` over the two copies at `shard-do.ts` ~5773–5788 and
  ~6075–6098) and only pays off cleanly after 072/073 land.

## Findings considered and rejected (Wave 4)

The audit confirmed the sync engine's security posture is **sound** — these were
checked and need no plan:

- **SQL injection** — the ctx-db/shape SQL paths parameterize (`?`/`$N`) and
  quote identifiers; no string-concatenated user input reaches `exec`.
- **Identity spoofing** — the worker strips client-supplied identity headers and
  re-injects server-verified `x-lunora-identity` / `x-lunora-userid`; the DO trusts
  only the forwarded values.
- **Authorization fail-closed** — RLS and the cross-shard relation fan-out gate
  (`authorizeFanOut`) deny by default; the reserved relation prefix is refused on
  single-shard envelopes.
- **RLS under live subscriptions** — confirmed correct (subscriptions evaluate
  under the socket's verified identity, fixed in `cb632cd7`; see the pinned
  memory). Not a regression.

Rejected / deferred opportunities:

- **PERF-03 — codegen AST re-walk** — REJECTED. Contradicts Wave-3 plan-063's
  measurement: warm dev-loop codegen is ~18–20ms (discovery-bound, not AST-walk
  bound) and the fresh-run cost is ts-morph Project construction, which this
  wouldn't touch. No leverage.
- **TECH-01 — `shard-do.ts` god-file split** — DEFERRED as a separate spike. The
  file is large but cohesive; a split is a big, risky, low-functional-value churn
  better scoped on its own with a design doc, not bundled into this wave.
- **CORR-02 (shard-key watermark edge), CORR-03 (poke-buffer eviction)** — NOT
  selected. CORR-03 is LOW confidence (couldn't construct a concrete failing
  interleaving); CORR-02 is a narrow edge the existing tests appear to cover.
  Left for a future targeted pass if symptoms appear.
- **TECH-02 / TECH-04** — minor; not selected this wave.

## Wave 5 — competitive gap analysis (PartyKit, baseline `9f779358`, 2026-06-29)

Compared Lunora against `cloudflare/partykit` (ISC). Most PartyKit primitives are
already covered by richer Lunora equivalents (`ShardDO` ⊃ partyserver,
`@lunora/client` ⊃ PartySocket, `@lunora/scheduler` ⊃ partywhen, `whisper` +
`usePresence` ⊃ presence/ephemeral broadcast, op-log+poke+`@lunora/db` ⊃
partysync). Two genuine gaps surfaced; one is filed as a design spike here. The
other (Yjs/CRDT collaborative editing via `y-partyserver`) is tracked separately
as a prospective `@lunora/collab` package and is **not** in this directory yet.

| Plan | Title                                                        | Category          | Pri | Effort | Risk | Status                                                                                                                                                                                                                                                  |
| ---- | ------------------------------------------------------------ | ----------------- | --- | ------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 075  | Auto-elastic fan-out relay tier (hidden high-fanout scaling) | perf/architecture | P3  | XL     | HIGH | Phases 0–2 SHIPPED (observability + design/calibration + whisper relay hub, runtime routing, collapse, Studio surface; workerd-proven). Follow-ups: per-topic granularity + demand-based relay right-sizing; Phase 3 (RLS-uniform reactive-shape relay) |

### Notes

- **075** is PartyKit's `partysub` reframed to Lunora's "scale without the user
  thinking about it" principle: not a user-facing pub/sub primitive but an
  **automatic internal elasticity** of the subscription transport. Depends on
  plans **072 + 073** (the "compute once" op-range and the identity-independence
  signal its RLS-uniform gate reuses). Phased: observability → whisper relay →
  RLS-uniform reactive-shape relay (incl. `usePresence`'s `listPresent`, which is
  a reactive query, not whisper) → collapse/ceiling. Start only if the
  live-broadcast / massive-public-room segment is an explicit product goal.
- **CRDT / collaborative editing** — the other PartyKit gap (`y-partyserver`).
  Reuse, don't rebuild: `y-partyserver` is ISC and solves Yjs document
  persistence + awareness, which map onto `ShardDO` storage + the `whisper`
  channel. Prospective `@lunora/collab`; no plan filed yet — file one if rich-text
  / canvas collaboration becomes a goal.

## Wave 6 — competitive gap analysis (workflais, baseline `0d0c8f1e`, 2026-06-30)

Compared `@lunora/workflow` against `mksglu/workflais` (declarative CF Workflows
DSL). Most of workflais is a thinner, less-integrated take on what Lunora already
ships (schema-validated `defineStep`/`runStep`, codegen-emitted
`WorkflowEntrypoint` classes + wrangler reconciliation, `ctx.run` durable
function calls, the `ctx.workflows` producer surface, REST instance management).
Its string-DSL (`ctx.prev`, `compile`/`execute`) is a deliberate non-goal. Two
genuine improvements surfaced:

| Plan | Title                                             | Category          | Pri | Effort | Risk | Status                                                                                                                                                                                                                                                                                                                                            |
| ---- | ------------------------------------------------- | ----------------- | --- | ------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —    | `workflow_duplicate_step_name` advisor lint       | feat (advisor)    | P2  | S      | LOW  | DONE (shipped) — codegen lifts durable step labels from the handler body; new static lint flags a name reused within one workflow (CF memoizes by name → second call returns the first's cached result). `discover-workflows.ts` + `WorkflowIR.steps`, `workflow-duplicate-step-name.ts`, tests green.                                            |
| 076  | Workflow fan-out with child-DO resource isolation | feat/architecture | P2  | XL     | MED  | PHASES 1–2 SHIPPED — `ctx.spawn` + `ctx.parallel(branch(...))` in `packages/workflow/src/fan-out.ts` (child-DO isolation, deterministic replay-safe ids, child→parent completion-event join, fail-fast, `MAX_BRANCHES` cap); base class signals the parent; 66 tests green, types/eslint clean. Remaining: Phase 3 group saga + real-workerd e2e. |

### Notes

- **The lint** is the cheap, certain win: duplicate `step.do`/`sleep`/
  `sleepUntil`/`waitForEvent` names are a silent CF correctness bug, now caught
  statically alongside `workflow_unknown_target` / `workflow_unused`.
- **076** is workflais' one novel idea — `parallel()` that spawns each branch as
  its own child workflow instance (own DO: 128 MB / 5 min CPU / independent
  retry), parent hibernating via `waitForEvent` — reframed to Lunora's "scale
  invisibly" principle as a typed `ctx.parallel(...)` over declared child
  workflows. Lunora has no fan-out primitive today; the only parallelism a user
  can express (`Promise.all` of `runStep`s) collapses onto one DO's shared budget.
  Phased: typed child-spawn → hibernating join → optional group saga. Start only
  if workflow fan-out is an explicit product goal.

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
