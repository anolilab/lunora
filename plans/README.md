# Implementation Plans

Advisor plan waves run against this repo. **Completed plans are removed from this
directory once shipped** (the record lives in git history and the tables below);
only deferred, blocked, or reference plans remain as files.

Status values: TODO | IN PROGRESS | DONE | BLOCKED (one-line reason) | REJECTED.

## Wave 1 — Cloudflare platform coverage (baseline `058071c8`, 2026-06-15)

Does lunora support a given Cloudflare product/binding? The 14 completed plans
(027–032, 034, 035, 038–043) shipped and were removed. **036 (Pipelines) has since
shipped and is likewise removed** (see status). Remaining (all P3, deferred):

| Plan | Cloudflare product        | Shape                                  | Status                                                                                                                                                                                                                                                              |
| ---- | ------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 033  | Stream (video)            | `@lunora/stream` (REST + signed URLs)  | TODO (P3, deferred)                                                                                                                                                                                                                                                 |
| 036  | Pipelines                 | hint-binding + `ctx` send helper       | DONE & REMOVED — shipped as `@lunora/bindings/pipelines` (`createPipelines` → `ctx.pipelines`, ActionCtx-only), wrangler `pipelines[]` validation + binding inference/reconcile (hint-only), codegen feature-probe + `emitPipelinesFragments`. Verified 2026-07-01. |
| 037  | Realtime / Calls (WebRTC) | optional TURN/SFU helper (out-of-core) | TODO (P3, deferred)                                                                                                                                                                                                                                                 |

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

**All 11 DONE & REMOVED** — shipped to `alpha` in a prior session (reconciled &
verified against live code 2026-07-01; plan files removed, this table + the
commits are the record).

| Plan | Title                                                          | Category  | Pri | Effort | Risk | Status                                                                                                                                                                     |
| ---- | -------------------------------------------------------------- | --------- | --- | ------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 064  | Redact raw `error.message` in DO RPC error fall-through        | security  | P1  | S      | LOW  | DONE — `dd340715` (#70): `shard-do.ts` fall-through returns generic `"internal error"`, logs raw server-side; test asserts redaction                                       |
| 065  | Keyed optimistic subscription fan-out (drop triple-match loop) | perf      | P1  | S      | LOW  | DONE — `lunora-client.ts` uses O(1) `SubscriptionRegistry.key(...)` lookup, triple-match loop gone                                                                         |
| 066  | Cache synced-row JSON in `@lunora/db` diff-emit                | perf      | P1  | S      | LOW  | DONE — `db/src/internals.ts` `makeDiffEmit` takes a `syncedJson` cache; each row stringified once                                                                          |
| 067  | Grouped relation count (kill N+1 in `resolveCounts`)           | perf      | P2  | M      | MED  | DONE — `do/src/relations.ts` issues one `GROUP BY … IN(values)` per relation (was per-value)                                                                               |
| 068  | Fix list optimistic overlay hang on unchanged mutator result   | bug       | P1  | M      | MED  | DONE — `dd340715` (#70): DO emits a lightweight `settled` frame with watermark; client `onCheckpoint` drops the overlay; DB wires the checkpoint gate                      |
| 069  | Tests: client shape re-seed on epoch fork / base divergence    | tests     | P2  | S      | LOW  | DONE — `74b7c250` (#63): `client/__tests__/shape-reseed.test.ts` (fork, base divergence, happy path + edges)                                                               |
| 070  | Tests: server shape resume-vs-reseed matrix                    | tests     | P2  | M      | LOW  | DONE — `6676048b` (#64): `do/__tests__/shard-do.shape-resume-matrix.test.ts` (parameterized `canResume` matrix)                                                            |
| 071  | Tests: mutator handler-failure watermark self-healing          | tests     | P2  | M      | LOW  | DONE — `fd6e03fe` (#65): `do/__tests__/shard-do.mutator-watermark-selfheal.test.ts` (6 cases + advance-gap)                                                                |
| 072  | Share op-log read across shape pokes in one flush              | perf      | P2  | M      | MED  | DONE — `dd340715` (#70): `readShapeOpRange()` + per-flush `opRangeCache`; membership probe stays per-shape; test validates one drain                                       |
| 073  | Dedup identity-independent reactive query runs across sockets  | perf      | P2  | M      | MED  | DONE — `dd340715` (#70): `isIdentityIndependent()` + `resolveReactiveOutcomeDeduped()` + flush-local `reactiveRunCache`; negative RLS test confirms no cross-identity leak |
| 074  | Extract shared socket-pool helper (dedup poke worker pools)    | tech-debt | P3  | S      | LOW  | DONE — `dd340715` (#70): `do/src/socket-pool.ts` `runSocketPool()`; both `refreshSubscriptions`/`pokeShapeSubscribers` call it; `socket-pool.test.ts`                      |

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

| Plan | Title                                                        | Category          | Pri | Effort | Risk | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---- | ------------------------------------------------------------ | ----------------- | --- | ------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 075  | Auto-elastic fan-out relay tier (hidden high-fanout scaling) | perf/architecture | P3  | XL     | HIGH | DONE & REMOVED — Phases 0–4 shipped. Ph0 design + Ph1 observability + Ph2 whisper relay hub + Ph3 RLS-uniform reactive-shape relay + **Ph4 demand-driven collapse w/ hysteresis** (`OwnerRelay.relayCount` + `nextPromotionState`; `LUNORA_RELAY_COLLAPSE_THRESHOLD`) **+ Studio "at ceiling" badge** — `ba55cb0f`, `@lunora/do` 993 tests green. **Ph4(c) static "relay-scalable" advisor lint intentionally deferred** (the RLS-uniform gate `probeShapeRelayUniform` is runtime-only — a static lint can't decide it; rationale in git history). Plan files removed 2026-07-01. |

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

| Plan | Title                                             | Category          | Pri | Effort | Risk | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---- | ------------------------------------------------- | ----------------- | --- | ------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —    | `workflow_duplicate_step_name` advisor lint       | feat (advisor)    | P2  | S      | LOW  | DONE (shipped) — codegen lifts durable step labels from the handler body; new static lint flags a name reused within one workflow (CF memoizes by name → second call returns the first's cached result). `discover-workflows.ts` + `WorkflowIR.steps`, `workflow-duplicate-step-name.ts`, tests green.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 076  | Workflow fan-out with child-DO resource isolation | feat/architecture | P2  | XL     | MED  | DONE & REMOVED — Phases 1–3 shipped. Ph1–2 `ctx.spawn` + `ctx.parallel(branch(...))` (child-DO isolation, replay-safe ids, hibernating join, fail-fast, `MAX_BRANCHES`); **Ph3 group saga** — a branch's `compensateWith` (declared compensation workflow) is spawned for each completed sibling in reverse order on group failure, replay-safe, `{branch,error,index,output}` params (`0e494f2f`, `fan-out.ts` + `types.ts`; 69 workflow tests green, codegen 482 golden unaffected). Design: compensation = declared workflow spawned by the parent (reuses spawn machinery; a completed child is a terminal instance) rather than cross-instance per-step rollback. Follow-up (not blocking): real-workerd e2e for spawn/join/saga. Plan file removed 2026-07-01. |

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

## Wave 7 — external ingest gap (Hyperdrive → DO shapes, baseline `825c5cc0`, 2026-06-30)

External question (Mats Erdkamp): a multitenant Postgres behind Hyperdrive, with
per-agent DOs that should each materialize only their own slice into their private
SQLite, and clients consuming that same slice. The **DO SQLite → client** half is
already shipped (`defineShape` + `@lunora/db`, RLS-filtered op-log pokes). The
missing half is the **upstream edge**: getting the external Postgres slice into the
per-agent DO in the first place (`ctx.sql` is action-only/non-reactive, no CDC).

| Plan | Title                                  | Category          | Pri | Effort | Risk | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | -------------------------------------- | ----------------- | --- | ------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 077  | Hyperdrive → per-agent DO shape ingest | architecture/data | P2  | XL     | HIGH | SIGNED OFF; PHASES 0–2 SHIPPED (verified 2026-07-01) — Ph0 design [077-phase0-design.md](077-phase0-design.md) (§11) + `__bench__/external-source-*` gate; Ph1 `pullSourceRows`/`projectSourceRow` in `@lunora/hyperdrive` + diff/materialize in `@lunora/do` + docs recipe; **Ph2 `.source()` modifier** (`server/src/schema.ts`, `ExternalSourceDefinition`) + codegen `pollExternalSources` emission + `external_source_unscoped`/`external_source_on_global` advisor lints + DO poll loop (`runExternalSourceTick`); end-to-end `.source()`→codegen→poll→materialize→`defineShape`→clients. Follow-ups: Phase 3 (live trigger→queue CDC), Phase 4 (DO-consumes-DO shape) |

### Notes

- **077** generalizes the **existing** `.global()`-table latency-tiered alarm poll
  (external read → diff vs durable baseline → poke) into an external-source
  materialization loop: poll Hyperdrive → diff → `applyCdcChanges` into a real local
  table → `defineShape` carries it to clients unchanged. Phase 1 blesses the manual
  `ctx.sql`→`ctx.db` bridge that unblocks the use case today; Phase 2 is the
  declarative `.source({ binding, query, tenantBy, refresh })` table modifier; Phase 3
  (optional, gated) is live trigger→queue CDC; Phase 4 (stretch, likely separate) is
  DO-consumes-another-DO's-shape. **Tenant scoping (shard key → source predicate) is
  the non-negotiable correctness boundary** — an unscoped sourced+sharded table would
  replicate the whole multitenant table into every agent.
- **Phase 0 benchmark** (`packages/do/__bench__/external-source-{materialize-tick,apply}.bench.ts`):
  full-pull steady tick is read-dominated — ~18 µs (10 rows) → ~1.4 ms (1k) → ~20 ms
  (10k); `applyCdcChanges` ~17 µs/row. Sets a ~10k full-pull row cap (incremental mode
  above) and a size-scaled cadence (2 s floor for ≲1k slices, slower for larger).

## Wave 8 — all-package sweep (baseline `c490bad7`, 2026-07-01)

Broad audit across **all 45 packages** (`/improve` "every package"), 8 read-only
Explore agents clustered by size/importance, steered away from the sync-engine
hot paths already covered by 064–078. The codebase is in strong shape after seven
prior waves, so the yield is a handful of small, high-confidence items — and a
notably high subagent false-positive rate (see "considered and rejected" below;
several headline "security" findings did not survive vetting against live code).
Every finding below was confirmed by first-hand reads; excerpts in each plan are
from the live code at `c490bad7`. **All 7 DONE — implemented, reviewed, and
consolidated onto `advisor/wave-8` (pushed to origin; PR against `alpha` to be
opened). Plan files removed per the directory convention; this table + the
commits are the record.**

| Plan | Title                                                        | Category | Pkg       | Pri | Effort | Risk | Status                                                                                                                                                                                                                               |
| ---- | ------------------------------------------------------------ | -------- | --------- | --- | ------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 079  | topK shard-merge total-order comparator (no `NaN`)           | bug      | runtime   | P2  | S      | LOW  | DONE — `advisor/wave-8` `6f0c073b` (orig `bc9f7d24`); reviewer re-ran `lint:types` + 433 tests green                                                                                                                                 |
| 080  | Report offline-queue `hydrate()` load failures               | bug/dx   | client    | P2  | S      | LOW  | DONE — `advisor/wave-8` `31c85c3c` (orig `1aec9f52`); reviewer re-ran `lint:types` + 292 tests green                                                                                                                                 |
| 081  | Make `.dev.vars` append atomic vs concurrent writers         | bug      | config    | P3  | S–M    | LOW  | DONE — `advisor/wave-8` `eaadf0b8` (orig `ab9f00a2`); reviewer re-ran `lint:types` + 377 tests green. In-scope deviation: `appendDevVariables` takes a `buildAdditions` closure so the CAS loop re-plans per attempt (true re-merge) |
| 082  | Log when a scheduled job is parked in the dead-letter store  | dx/obs   | scheduler | P3  | S      | LOW  | DONE — `advisor/wave-8` `9299e16f` (orig `1173a002`); diff reviewed (console.warn, id+functionPath, no args), 102 tests green                                                                                                        |
| 083  | Serialize flag-eval context once per request (memo-key perf) | perf     | flags     | P3  | S      | LOW  | DONE — `advisor/wave-8` `1256edd2` (orig `07e54ec5`); diff reviewed (self-delimiting key, empty-context short-circuit), 51 tests green                                                                                               |
| 084  | Guard `releaseClaim` on the migration pause path             | bug      | do        | P3  | S      | LOW  | DONE — `advisor/wave-8` `9cfcbe05` (orig `914f501c`); diff reviewed (try/catch, main rethrow intact, stubbed-UPDATE test), 992 tests green                                                                                           |
| 085  | Reject empty / whitespace-only `lunora init` project names   | bug      | cli       | P3  | S      | LOW  | DONE — `advisor/wave-8` `f62b8427` (orig `f7ac5afb`); diff reviewed (trimmed-empty guard before traversal check), 521 tests green                                                                                                    |

> **Wave 8 integration (2026-07-01):** all 7 approved commits consolidated onto
> branch **`advisor/wave-8`**, linear history on top of `origin/alpha`
> (`origin/alpha` was at `c490bad7`, the plans' baseline — 0 commits ahead, so
> the rebase was a confirmed no-op). Order: 079 topK `6f0c073b` → 080 client
> `31c85c3c` → 081 config `eaadf0b8` → 082 scheduler `9299e16f` → 083 flags
> `1256edd2` → 084 do `9cfcbe05` → 085 cli `f62b8427`. 14 files (7 source + 7
> test), disjoint packages, no `plans/` committed. The seven individual
> `advisor/NNN-*` branches are preserved. **Pushed to origin; PR against `alpha`
> to be opened.** The seven `079-085-*.md` plan files were **removed** after this
> table captured the record (they were never committed; the code lives in the
> commits above).
>
> **Wave 8 execution note (2026-07-01):** all 7 plans dispatched to isolated-worktree executors. Each plan's code lives on its own `advisor/NNN-*` branch (worktrees under `.claude/worktrees/`); **none merged to `alpha` — that is the user's call.** Reviewer read every diff and independently re-ran the two P2 suites (079, 080). Executors' `git` commands landed in the shared main checkout (only Read/Edit were worktree-isolated), causing transient `advisor/* ↔ alpha` HEAD bounces that all netted back to `alpha`; the pre-existing `feat/077 → alpha` switch + `pull` at 11:04 predates the executors (not caused by this run). `feat/077-hyperdrive-do-shape-ingest` was deleted before the run and is recoverable at `67109d3e`.

### Recommended execution order

All seven are independent (no cross-plan deps) and small. Recommended order by
leverage: **079, 080** first (the two P2 correctness/durability wins with clean
verification), then the P3 quick wins **081 → 082 → 083 → 084 → 085** in any order.
Each is scoped to one package and re-runs that package's `lint:types` + `test` as
its gate.

### Findings considered and rejected (Wave 8)

Vetted against live code and dropped — recorded so they aren't re-audited:

- **ratelimit "fails open on store error"** — FALSE POSITIVE. The subagent audited
  `rate-limiter.ts` in isolation; the `rateLimit` middleware (`middleware.ts:62-82`)
  wraps `limit()` in try/catch and **fails closed (503) by default**, with an
  explicit documented `failOpen` opt-in.
- **dispatch `response.text()` double-read** (`create-dispatch-runner.ts:74-78`) —
  FALSE POSITIVE. The two `.text()` calls are on mutually exclusive paths (`throw`
  inside `if (!response.ok)` exits before the success-path read).
- **D1 `getBookmark` null→undefined coercion** (`d1-client.ts:124`) — by design; the
  wrapper's documented contract returns `undefined` for "no bookmark yet".
- **client WebSocket listeners "never removed"** (`lunora-client.ts:3159+`) — not a
  leak; the four listeners belong to the local `socket`, which is dereferenced
  (`conn.socket` reassigned) and GC'd with its listeners when superseded. Guarded
  standard pattern (`if (conn.socket !== socket) return`).
- **optimistic-layer transform swallow** (`optimistic-layers.ts:42-47`) — by design;
  a throwing layer is skipped and the error surfaces on mutation settle (documented).
- **react cache polling ignores tab visibility** (`react/src/cache.ts:84`) — only the
  WS-unavailable fallback timer; narrow, low impact. Not selected.
- **browser DNS-rebinding SSRF** — documented out-of-scope in `create-browser.ts:195-197`;
  the SSRF guard (protocol / private-IP / credential-strip) is sound.
- **studio admin token in `sessionStorage`** — subagent's threat model is wrong:
  `sessionStorage` is cleared on tab close and does NOT survive a browser restart
  (that is `localStorage`). Documented deliberate tradeoff; studio is a local UI.
- **browser `clampViewport` partial object**, **payment webhook-replay / money BigInt
  precision / auth `withoutHeaders` collision / signed-URL safe-integer**, **runtime
  topK-`k` unbounded / admin-RPC rate-limit / fan-out partial-result policy**, **cli
  secret-name quoting / `Promise.all`→`allSettled` / dev-stream error handler**,
  **analytics `track()` name validation** — all type-guarded, app-boundary,
  threat-model-dependent, or negligible-impact nits; not worth plans.
- **SessionDO GC alarm re-arm** (`session-do.ts:273`) — reconsidered on close read
  and REJECTED: the `if (remaining > 0 …)` guard is correct, because `remaining === 0`
  means all expired records were just deleted in the same sweep (no residue to
  reclaim), and any later `create()` re-arms via `armGcAlarm()`. Self-heals.

### Not audited this pass

- **Direction / roadmap** (features, what to build next) — out of scope for this
  correctness/security/perf/tests/tech-debt sweep. Run `/improve next` for a
  grounded direction pass.
- **Docs** category — only spot-checked.
- **Plausible test-coverage / tech-debt leads surfaced but not selected** (would
  need gap-confirmation before planning): workflow fan-out failure-mode tests
  (`packages/workflow`), MCP tool-surface authz/error tests (`packages/mcp`),
  codegen namespace-collision test for case-insensitive filesystems
  (`packages/codegen`), advisor static-lint edge-case predicate dedup
  (`packages/advisor`).
## Wave 9 — auth hot-path hardening + typed identity layer (baseline `c490bad`, 2026-07-01)

Three `@lunora/auth` / identity findings, landed together off `alpha`. Two harden
the authenticated hot path (091/093): the session read hits D1 on every call (no
cookie cache), and rate limiting reports "enabled" while not enforcing a global
limit on Workers (per-isolate memory store, no atomic increment). The third (092)
types identity generically — whatever `resolveIdentity` returns becomes `ctx.auth`,
but beyond `userId` the claims were untyped and composition was DIY, so 092 makes
the claim contract **declared** (codegen reads it as reliably as `defineSchema`)
and gives first-class resolver composition. 091 and 093 both touch `create-auth.ts`'s
`resolvedOptions` caller-silence fill, so they landed in order (091 then 093 on top).

| Plan | Title                                        | Category        | Pri | Effort | Risk | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---- | -------------------------------------------- | --------------- | --- | ------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 091  | Default a short-lived session cookie cache   | perf            | P2  | S      | LOW  | DONE — `session.cookieCache { enabled, maxAge=60s }` filled on caller silence in `create-auth.ts`; `rolling`/`longLived` presets enable it, `strict` opts out; tests green.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 092  | Generic typed identity layer                 | dx/codegen/auth | P2  | L      | MED  | DONE — `defineIdentity` (`@lunora/server`), the `wrapResolverWithContract` validation boundary + `composeIdentityResolvers`/`routeIdentityResolvers` (extracted to `@lunora/runtime`'s `identity-resolvers.ts`), `createPolicyDsl`'s identity type param, AND codegen auto-emission of the narrowed `ctx.auth.getIdentity()` into `_generated/server.ts` — codegen discovers the single `defineIdentity(...)` in `lunora/identity.ts` (like `defineSchema`), recovers the claim type via `InferIdentity<typeof …>`, and narrows `getIdentity()` + the RLS policy `ctx.auth.identity`. The boundary now fires end-to-end in generated apps: `_generated/app.ts` imports the contract as a value and wires `options.identity`, so `wrapResolverWithContract` actually validates a resolver's claims (previously the type narrowed but the runtime gate stayed inert). Byte-identical when no contract is declared. Phase 3 (better-auth plugin inference) + the 094 follow-on lint remain deferred. |
| 094  | `auth_session_read_without_cache` lint       | advisor/perf    | P2  | S      | LOW  | DEFERRED — lives as the "Follow-on 094" section inside `092-typed-identity-layer.md`; gated on 091 (landed) and builds its own `createAuth`-config reader.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 093  | Durable, atomic rate limiting (incrementOne) | fix             | P1  | M      | MED  | DONE — native atomic `incrementOne` on `AuthStore` (memory + SQL) + `adapter.ts`; durable `rateLimit.storage: "database"` default (caller-silence-gated); concurrency no-lost-update test for both stores. Companion known-limitations docs deferred (out of code scope).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### Notes

- **091** verified better-auth `1.6.22`: `session.cookieCache` takes `{ enabled,
maxAge }` (seconds; better-auth default `maxAge` is 300s, lowered to 60s here).
  The default is gated on `session?.cookieCache === undefined`, mirroring the
  `rateLimit.enabled === undefined` fill, and composed into the same
  `resolvedOptions` object so **093** can add its `rateLimit.storage` fill alongside.
- **092** never introspects `createAuth` — Phase 1+2 read a `defineIdentity(...)`
  declaration statically (like `defineSchema`), which dissolves the introspection
  cliff the earlier framing carried. `defineIdentity` builds on the `@lunora/values`
  validator machinery (`parseValidatorMap`), **not** the replication `defineShape`
  API (a table+predicate, not a claim record) — matching the plan's first STOP
  condition's own remediation ("its own light type rather than reusing `defineShape`
  wholesale"). `composeIdentityResolvers`/`routeIdentityResolvers` (renamed from the plan's
  `composeResolvers`/`routeResolvers` to avoid clashing with `@lunora/cloudflare-access`'s
  existing variadic `composeResolvers`) live in `@lunora/runtime`
  (co-located with `ResolvedIdentity`/`resolveIdentity`, structurally free of
  `@lunora/server`), not `@lunora/auth`, so the generic primitives stay decoupled
  from better-auth — the whole point of a generic identity layer.
- **093** verified better-auth `1.6.22`: `incrementOne` exists as an **optional**
  `CustomAdapter` method — a guarded `UPDATE … SET col = col + delta … RETURNING`
  (the plan's `INSERT … ON CONFLICT` upsert was wrong; better-auth `create`s the
  row separately and calls `incrementOne` only as a guarded counter bump). Default
  `rateLimit.storage` is `"memory"` (per-isolate, non-durable); `"database"` routes
  through the configured DB adapter (Lunora's store). Defaulting storage to
  `"database"` surfaced STOP-condition 3 as a **test-fixture gap** — the durable
  limiter needs a `rateLimit` table that `getAuthTables` emits only when
  `storage === "database"`; `forget-password-route.test.ts` now materialises the
  schema from that resolved storage, mirroring what a real Lunora migrator does.
- The codegen auto-narrowing reuses the workflows/queues precedent: it imports the
  app's contract by type (`import type * as … from "../identity.js"`) and reads it
  via `typeof` + `InferIdentity` — no parallel type system, no runtime import, and
  every fragment is gated on the contract existing, so the no-`defineIdentity`
  golden stays byte-identical.

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
