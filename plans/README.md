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

| Plan | Title                                             | Status                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 044  | Docs/AGENTS.md package coverage                   | DONE (shipped)                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 045  | Testing-harness coverage (scheduler/fetch/subs)   | DONE (shipped)                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 046  | Shared pagination core in `@lunora/client`        | DONE (shipped, folded into 047)                                                                                                                                                                                                                                                                                                                                                                                                          |
| 047  | Vue/Solid/Svelte adapter parity with React        | DONE (shipped)                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 048  | Inner-loop error-UX papercuts                     | DONE (shipped)                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 049  | MCP function-schema introspection tool            | DONE (shipped)                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 050  | Expand advisor runtime lints                      | REJECTED & REMOVED — the two proposed lints already exist as the two halves of the existing `index_utilization` runtime lint. Plan file deleted; record in git history.                                                                                                                                                                                                                                                                  |
| 051  | Thread project version into OpenAPI/OpenRPC specs | DONE (shipped)                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 052  | [Spike] Typed HTTP-SSE stream consumer            | DONE (shipped, React-first) — codegen emits `httpStreams.*` `HttpStreamRef`s (chunk type inferred from the `.stream()` handler), `@lunora/client` gained the `httpStream` fetch/`ReadableStream` SSE consumer + `client.httpStream`, `@lunora/react` `useHttpStream`. Spike file removed; decisions + open questions in [052-streaming-hook-design.md](052-streaming-hook-design.md). Vue/Solid/Svelte port deferred (plan 047 pattern). |
| 053  | Batch mutations (insertMany/deleteMany/patchMany) | BUILD IMPLEMENTED (pending commit/review) — all three on `DatabaseWriter` per the §8 decisions (Q1 all-or-nothing, Q5 cap 500); tests green. Design doc removed; record in git history.                                                                                                                                                                                                                                                  |
| 054  | Package-aware `.dev.vars` secrets scaffolding     | DONE (shipped)                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 055  | Workflows & Queue observability in Studio         | DONE & REMOVED — workflows REST proxy + studio instance history and scheduler dead-letter + workpool observability both shipped; Queues migration analyzed and rejected (the two workpool backends coexist by design). Record in git history.                                                                                                                                                                                            |
| 056  | Resolve `node_modules` schema extensions          | DONE & REMOVED — codegen runtime-introspects `.extend(pkg.extension)` from a published package (sync `require(esm)` from the project root → bare `TableIR`; fail-safe to warn+skip; handles named/default/namespace imports). Plan file deleted; record in git history.                                                                                                                                                                  |

### Notes

- **046** was cherry-picked into **047**'s branch, so the shared pagination core
  and the adapter parity work shipped together in one commit on `alpha`.
- **048 ↔ 054** both touched `cli/src/commands/dev/handler.ts`
  (`offerDevVariablesScaffold`); the two changes were merged by hand on integration.
- **052** was rewritten (the original WS premise was wrong — `use-stream.ts`
  already consumes the WS `kind:"stream"` procedure), then shipped React-first:
  codegen-emitted `httpStreams.*` `HttpStreamRef`s, the `@lunora/client`
  `httpStream` SSE consumer, and `useHttpStream`. Decisions + open questions
  (reconnect policy, adapter parity, POST bodies) live in
  [052-streaming-hook-design.md](052-streaming-hook-design.md).
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

| Plan | Title                                  | Category          | Pri | Effort | Risk | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---- | -------------------------------------- | ----------------- | --- | ------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 077  | Hyperdrive → per-agent DO shape ingest | architecture/data | P2  | XL     | HIGH | PHASES 0–2 SHIPPED & REMOVED (verified 2026-07-01; PR #80, `d5cf9151e`) — Ph0 design + `__bench__/external-source-*` gate (~10k full-pull cap, size-scaled cadence); Ph1 `pullSourceRows`/`projectSourceRow` in `@lunora/hyperdrive` + diff/materialize in `@lunora/do` + docs recipe; **Ph2 `.source()` modifier** (`server/src/schema.ts`, `ExternalSourceDefinition`) + codegen `pollExternalSources` emission + `external_source_unscoped`/`external_source_on_global` advisor lints + DO poll loop (`runExternalSourceTick`); end-to-end `.source()`→codegen→poll→materialize→`defineShape`→clients. Design docs removed 2026-07-04 (record in git history). **Deferred Phase 3 (live trigger→queue CDC) + Phase 4 (DO-consumes-DO shape) rehomed to [133-live-cdc-and-do-consumes-do.md](133-live-cdc-and-do-consumes-do.md) (P3, demand-gated — NOT recommended to build speculatively).** |

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

Spent — the whole wave shipped in one branch (PR #229).

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
| 091  | Default a short-lived session cookie cache   | perf            | P2  | S      | LOW  | DONE & REMOVED — `session.cookieCache { enabled, maxAge=60s }` filled on caller silence in `create-auth.ts`; `rolling`/`longLived` presets enable it, `strict` opts out; tests green.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 092  | Generic typed identity layer                 | dx/codegen/auth | P2  | L      | MED  | DONE — `defineIdentity` (`@lunora/server`), the `wrapResolverWithContract` validation boundary + `composeIdentityResolvers`/`routeIdentityResolvers` (extracted to `@lunora/runtime`'s `identity-resolvers.ts`), `createPolicyDsl`'s identity type param, AND codegen auto-emission of the narrowed `ctx.auth.getIdentity()` into `_generated/server.ts` — codegen discovers the single `defineIdentity(...)` in `lunora/identity.ts` (like `defineSchema`), recovers the claim type via `InferIdentity<typeof …>`, and narrows `getIdentity()` + the RLS policy `ctx.auth.identity`. The boundary now fires end-to-end in generated apps: `_generated/app.ts` imports the contract as a value and wires `options.identity`, so `wrapResolverWithContract` actually validates a resolver's claims (previously the type narrowed but the runtime gate stayed inert). Byte-identical when no contract is declared. Phase 3 (better-auth plugin inference) + the 094 follow-on lint remain deferred. |
| 094  | `auth_session_read_without_cache` lint       | advisor/perf    | P2  | S      | LOW  | DEFERRED — lives as the "Follow-on 094" section inside `092-typed-identity-layer.md`; gated on 091 (landed) and builds its own `createAuth`-config reader.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 093  | Durable, atomic rate limiting (incrementOne) | fix             | P1  | M      | MED  | DONE & REMOVED — native atomic `incrementOne` on `AuthStore` (memory + SQL) + `adapter.ts`; durable `rateLimit.storage: "database"` default (caller-silence-gated); concurrency no-lost-update test for both stores. Companion known-limitations docs deferred (out of code scope).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

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

## Wave 10 — security-audit run-1 remediation (baseline `8b71a38b`, 2026-07-02)

A deep run-1 security audit of the runtime + all add-ons. The bulk of the findings
(fan-out confused-deputy, write-only-RLS read-open, payment `incomplete`
entitlement, SSRF trailing-dot, mask/flag oracles, RLS write-gate leak, scheduler
double-exec, and the deferred hardening batch: browser DNS-rebinding, mail policy
docs, CLI template SHA-pinning, `quoteIdentifier` dedup) shipped **directly as
commits** on `fix/security-audit-run-1`, not as plan files — the record is in git
history and PR #90. Only the one item needing a coordinated multi-component change
remains as a plan.

| Plan | Title                                  | Category     | Pri | Effort | Risk | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---- | -------------------------------------- | ------------ | --- | ------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 095  | Keep the admin token out of the WS URL | fix/security | P2  | M      | MED  | DONE & REMOVED — closes run-1 finding L4. All 3 phases shipped: `shared/ws-admin-token.ts` mint/verify + `POST /_lunora/admin/ws-token` + async worker/DO WS gates (master OR ephemeral); client `WsTokenProvider` + studio mint-before-connect (cache, ~10s-early refresh, 404 fallback, 4001 invalidate); opt-in enforcement via `requireEphemeralWsToken` / `LUNORA_REQUIRE_EPHEMERAL_WS_TOKEN` rejecting the raw master token in `?token=`. Verified 2026-07-16. |

## Wave 11 — all-package + DX + direction sweep (baseline `fc9c915b`, 2026-07-03)

Broad `/improve` pass ("check all packages, and the lunora dx for improvements,
new ideas, or performance issues"). Four read-only Explore agents: performance
(hot paths + the never-audited studio/wire-codec/KV surfaces), DX (the full
`lunora init → dev → codegen → deploy` journey), direction (grounded
what-to-build-next), and correctness on the delta since the Wave-8 baseline
`c490bad7` (KV browser, Cap'n-Web wire codec + batch, typed identity, the
security-remediation commit itself, relay follow-ups). Every finding below was
**vetted first-hand against live code** at `fc9c915b`; excerpts in each plan are
from those reads. The delta-correctness pass confirmed the Wave-10 security
remediation is otherwise correct and complete (RLS write-gate, payment
entitlement, fan-out confused-deputy, scheduler double-exec, KV admin-token
gating, wire-codec `__proto__`/bigint/typed-array handling all verified), and
refuted the Wave-8 test-coverage leads (workflow fan-out + MCP authz tests
already exist). **All plans TODO — none executed yet.**

User selected **all** fix findings + **all** direction findings for planning.

### Fix plans

| Plan | Title                                                               | Category       | Pkg                      | Pri | Effort | Risk    | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---- | ------------------------------------------------------------------- | -------------- | ------------------------ | --- | ------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 096  | Route wrangler/tsc spawns through the detected package manager      | dx/bug         | cli                      | P1  | M      | LOW     | **DONE** — PR [#98](https://github.com/anolilab/lunora/pull/98) (branch `advisor/wave11-cli-dx`). All 9 spawn sites use `execArgsFor(detectPackageManager(cwd), …)`; secret-put stays on stdin (never argv — verified); 8 npm-path assertions added; 545 cli tests green.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 097  | Fix the broken `codegen` script path in all six examples            | dx/bug         | examples                 | P2  | S      | LOW     | **DONE** — PR [#98](https://github.com/anolilab/lunora/pull/98). Used the explicit `node node_modules/lunorash/dist/bin.mjs codegen` form (bare `lunora` bin is not linked in monorepo examples — dist built post-install); smoke-tested in todo-app. Templates keep bare `lunora codegen` (correct for published scaffolds).                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 098  | Run codegen before `typecheck` in the react-router template         | dx             | templates                | P2  | S      | LOW     | **DONE** — PR [#98](https://github.com/anolilab/lunora/pull/98). `typecheck` now runs `lunora codegen &&` first (react-router was the only template with a typecheck script).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 099  | Package-manager-neutral `init` guidance + template READMEs          | dx             | cli/templates            | P3  | S      | LOW     | **DONE** — PR [#98](https://github.com/anolilab/lunora/pull/98). New `installCommand()` renders overlay next-steps with the detected manager; all 8 template READMEs softened to neutral form.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 100  | `lunora dev` hints the framework dev script in Vite projects        | dx             | cli                      | P3  | S      | LOW     | **DONE** — PR [#98](https://github.com/anolilab/lunora/pull/98). `planDevCommand` sets `frameworkHint` (pure/testable); the runner logs it before spawning wrangler (behavior unchanged). Committed as `feat(cli)` (commitlint rejects `dx`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 101  | Typed client error-code discriminators + react re-export            | dx             | client/react             | P2  | M      | LOW     | **DONE** — PR [#93](https://github.com/anolilab/lunora/pull/93) (branch `advisor/wave11-client-errors`). Client-local `LunoraErrorCode` union (all 12 server codes, no `@lunora/server` import) + `isForbiddenError`/`isUnauthorizedError`/`isRateLimitedError`/`getErrorCode`/`getRetryAfterMs`; `code` widened to `LunoraErrorCode \| (string & {})`; re-exported from client + react. 339 client tests green; react lint:types green. Reviewer-verified scope + diff.                                                                                                                                                                                                                                                                             |
| 102  | Close the mask() value-oracle on `withIndex`/`withSearchIndex`      | security       | server                   | P2  | M      | MED     | **DONE** — PR [#94](https://github.com/anolilab/lunora/pull/94) (branch `advisor/wave11-mask-security`). **Strategy A (precise):** a blanket-`get`-trap Proxy records every field named in the `withIndex`/`withSearchIndex` builder callback (fail-closed by construction — no fixed allow-list), and `assertIndexFieldsAllowed` throws `MASK_UNSUPPORTED` before delegating; legitimate non-masked-column index reads still work. 387 server tests green. Reviewer-verified: guard fires on both readers pre-delegation, scope = middleware.ts + mask.test.ts.                                                                                                                                                                                     |
| 103  | Harden wire-codec error decode vs `__proto__` via `Object.assign`   | security       | shared/client            | P3  | S      | LOW     | **DONE** (REPRODUCED, not rejected) — PR [#93](https://github.com/anolilab/lunora/pull/93). The setter swap was confirmed at alpha (`Object.getPrototypeOf(decoded)` returned the injected object, not `Error.prototype`); fixed by replacing `Object.assign` with a key-wise merge using the `UNSAFE_KEY` guard (the sole remaining `Object.assign(error` string is a comment). Regression test asserts the prototype is preserved. Reviewer-verified.                                                                                                                                                                                                                                                                                              |
| 104  | Memoize per-table column kinds in the sql-store row decoder         | perf           | sql-store                | P3  | S      | LOW     | **DONE** — PR [#95](https://github.com/anolilab/lunora/pull/95) (branch `advisor/wave11-perf`). `field→kind` list cached once per definition in a `WeakMap` (identity confirmed stable — comes from `schema.tables[*]`); 29 sql-store tests green.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 105  | Stop re-running the full-table COUNT(*) on every data-browser page  | perf           | do/studio                | P3  | S–M    | LOW–MED | **DONE** — PR [#95](https://github.com/anolilab/lunora/pull/95). Server `skipCount` on `readTablePage` (+ 1-line arg parser in `shard-do.ts`, `total` now optional); client splits the count into a separate `live` query keyed on the predicate only (no `offset`/`pageSize`), so paging never re-COUNTs and live writes still update the total (both queries share the table dependency). First-load lower-bound fallback avoids "0 of 0". Reused `readTablePage` with `limit:1` (avoids the `limit:0` STOP). 59 introspect tests green; studio lint:types/eslint green.                                                                                                                                                                           |
| 106  | Collapse codegen feature-usage detection into one AST pass per file | perf/tech-debt | codegen                  | P3  | S      | LOW     | **DONE** — PR [#95](https://github.com/anolilab/lunora/pull/95). Single per-file `contextPropertiesRead` collector replaces the per-feature double-walk; 496 codegen tests green, **golden output byte-identical**. Aliased-destructuring test added. ⚠ conflicts with 112 on `discover-feature-usage.ts` — rebase 106 before 112.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 107  | Code-split the Studio so panels + heavy deps load on demand         | perf           | studio + cli/vite/config | P3  | L      | MED     | **DONE (needs rebase)** — PR [#100](https://github.com/anolilab/lunora/pull/100) (branch `advisor/wave11-studio-split`). **Spike PASSED**: esbuild `splitting` emits `studio.js` + 88 relative-ref chunks; `recharts` + `@xyflow/react` confirmed **outside** Home's 26-file eager set (entry ~2.5mb→560kb). Three hosts serve the chunk dir by basename via a unit-tested `resolveContainedFile` traversal guard (rejects `..`/absolute/NUL). Library `dist/mount.js` untouched. All gates green. ⚠ **GitHub reports CONFLICTING** — the 238-line `studio.tsx` rewrite overlaps the concurrent KV-browser work on `alpha` and plan 112's route add (#97); needs a rebase at merge time. Reviewer must smoke-test the live dev studio (Network tab). |

### Direction plans (design/spike unless noted)

| Plan | Title                                                            | Category      | Pri | Effort | Risk     | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---- | ---------------------------------------------------------------- | ------------- | --- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 108  | `lunora add payment` registry item (+ pattern for heavy add-ons) | feature/dx    | P2  | M      | LOW      | **DONE & REMOVED** — registry item at `registry/payment/` scaffolds `lunora/payment/index.ts` (checkout/track/check/portal/subscriptions/webhook), env vars `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`, deps `@lunora/payment` + `stripe`. Post-add `docs` explains the `createShardDO({ payment: ... })` / `httpRouter` wiring (same pattern as `storage` — manual, documented, not automated). Also delivered as part of the unblock: a new **`entrypointReexports`** registry engine capability (`RegistryManifest.entrypointReexports`) — registry items can declare `module`s to re-export from the worker entry; the engine injects `export * from "./lunora/<module>"` lines into class-B/C workers (idempotent), with diff/preview support and class-A fallback instruction. This unblocks future `workflow`/`container` items that need entrypoint re-exports.     |
| 109  | First-class `@lunora/angular` reactive adapter                   | feature       | P2  | M–L    | LOW      | **DONE** — PR [#99](https://github.com/anolilab/lunora/pull/99) (branch `advisor/wave11-angular`). New `packages/angular` exports `provideLunora`/`injectLunoraClient`/`liveQuery` (signal, teardown on `DestroyRef.onDestroy`, `"skip"` sentinel)/`mutate`/`connectionStatus`. **Design: no Angular decorators → plain packem build with `@angular/core` externalized** (avoids adding ng-packagr to CI — dodges the STOP condition); the decorated `@Injectable` stays in the template. Teardown proven 2 ways; 13 tests green. Added to `pnpm-workspace.yaml` overrides; analog template repointed. Parity extras (paginated/optimistic/auth/flags) deferred.                                                                                                                                                                                                               |
| 110  | [Spike] `@lunora/next` composition adapter + `templates/next`    | feature/spike | P2  | L      | MED      | **SPIKE DONE** — PR [#96](https://github.com/anolilab/lunora/pull/96), design [110-phase0-design.md](110-phase0-design.md) + prototype. Recommendation: Next is class-B; reuse the shipped `withFrameworkWorker` at the OpenNext **custom-worker boundary** (WebSocket MUST mount there — a Next Route Handler strips the `101` upgrade). Open Q: OpenNext version pinning + a validator; remove the `init` no-op only when `templates/next` lands. No STOP.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 111  | [Spike] RAG helper coupling `ctx.ai.embed` + `ctx.vectors`       | feature/spike | P2  | M      | LOW–MED  | **SPIKE DONE** — PR [#96](https://github.com/anolilab/lunora/pull/96), design [111-phase0-design.md](111-phase0-design.md) + prototype (ran over the real `createVectors`). Recommendation: thin `defineRag(config)(ctx)` as a `@lunora/ai/rag` subpath (not a new binding/codegen `ctx.rag`), no public-surface change, respects topK≤20-with-metadata + namespace isolation. Open Q: where chunk text lives (metadata vs DO SQLite table); `LunoraVectors` lacks delete-by-source. No STOP.                                                                                                                                                                                                                                                                                                                                                                                  |
| 112  | Studio Containers observability page                             | feature       | P3  | M      | LOW      | **DONE** — PR [#97](https://github.com/anolilab/lunora/pull/97) (branch `advisor/wave11-studio-containers`). **Data source A** (fold the lifecycle events already in the root `LogBuffer` via `getLogs` — no new RPC, no runtime change). Added a `container` codegen PROBE + `containers` feature flag (golden output changes by exactly one `"containers": false` line), a pure unit-tested `foldContainerInstances` reducer, and a `QueuesPanel`-modeled table gated on the flag. **Scoped honestly**: container metadata exposes no per-instance ports/health, so the panel shows lifecycle state + last transition and notes the gap (STOP-cond-3 "scope to available"). 497 codegen tests green; studio lint:types/eslint green. ⚠ conflicts with 106 (`discover-feature-usage.ts`) and 107 (`studio.tsx`) — rebase after both. Reviewer must smoke-test live rendering. |
| 113  | [Spike] Durable AI-agent primitive (`defineAgent`)               | feature/spike | P2  | XL     | MED–HIGH | **SPIKE DONE** — PR [#96](https://github.com/anolilab/lunora/pull/96), design [113-phase0-design.md](113-phase0-design.md) + PoC (asserts thread ordering AND resume-doesn't-re-run-a-completed-tool; step-name is the idempotency key → no `@lunora/workflow` change). **Recommendation: document-first + an opt-in `@lunora/agent` add-on**, not a core primitive — the build-vs-document tension with "scale invisibly" is surfaced as the top open question for the maintainer to ratify. No STOP.                                                                                                                                                                                                                                                                                                                                                                         |

### Execution (2026-07-03) — 8 PRs, dispatched in parallel via isolated-worktree executors

All plans were executed in one parallel wave (9 grouped branches, each an
isolated-worktree `general-purpose` executor branched off `origin/alpha`, gates
looped to green, self-pushed, self-PR'd; reviewer re-verified scope + diff +
tests per closing-the-loop). **18 of 18 plans DONE.**

| PR                                                  | Branch                              | Plans         | Mergeable                                                                         |
| --------------------------------------------------- | ----------------------------------- | ------------- | --------------------------------------------------------------------------------- |
| [#93](https://github.com/anolilab/lunora/pull/93)   | `advisor/wave11-client-errors`      | 101, 103      | ✅                                                                                |
| [#94](https://github.com/anolilab/lunora/pull/94)   | `advisor/wave11-mask-security`      | 102           | ✅                                                                                |
| [#95](https://github.com/anolilab/lunora/pull/95)   | `advisor/wave11-perf`               | 104, 105, 106 | ✅                                                                                |
| [#96](https://github.com/anolilab/lunora/pull/96)   | `advisor/wave11-spikes`             | 110, 111, 113 | ✅                                                                                |
| [#97](https://github.com/anolilab/lunora/pull/97)   | `advisor/wave11-studio-containers`  | 112           | ✅                                                                                |
| [#98](https://github.com/anolilab/lunora/pull/98)   | `advisor/wave11-cli-dx`             | 096–100       | ✅                                                                                |
| [#99](https://github.com/anolilab/lunora/pull/99)   | `advisor/wave11-angular`            | 109           | ✅                                                                                |
| [#100](https://github.com/anolilab/lunora/pull/100) | `advisor/wave11-studio-split`       | 107           | ⚠ CONFLICTING (needs rebase — studio.tsx overlaps concurrent alpha KV work + #97) |
| — (delivered)                                       | `advisor/108-registry-payment-item` | 108           | ✅ engine capability + payment item                                               |

**Merge-order notes for the maintainer:** #95 (106) and #97 (112) both touch
`discover-feature-usage.ts` → land #95 first. #100 (107) and #97 (112) both touch
`studio.tsx`, and #100 also overlaps the in-flight KV-browser work on `alpha` →
#100 needs a rebase; sequence the studio PRs deliberately (107 rewrite first, then
112's route add re-applied as a lazy route). #93 may need a trivial rebase (it
branched just before a concurrent alpha push).

### Recommended execution order & dependencies

- **Quick DX wins first (independent, S):** 097, 098, 099, 100 — one-file/script
  fixes, land in any order.
- **P1 breakage:** 096 (package-manager spawns) — the highest-leverage fix; 099
  complements it (printed guidance) but neither blocks the other.
- **Ergonomics:** 101 (typed errors) — standalone, M.
- **Security:** 102 (mask index oracle) — MED risk, written with a precise-vs-blunt
  strategy choice + STOP conditions. 103 is INVESTIGATE-first (may resolve to
  REJECTED if not reproducible).
- **Perf (independent, mostly S):** 104, 105, 106 — small, isolated. 107 (studio
  split) is L and **spike-gated** (STOP if esbuild can't emit servable chunks).
- **Direction:** 108 (registry payment) and 109 (Angular) are concrete builds;
  110/111/113 are **design/spike plans** (produce a design doc + prototype, STOP
  at open questions — do not build the full feature); 112 is a concrete panel that
  depends on a codegen `container` PROBE. 111 (RAG) should precede any 113 (agent)
  build — the agent's memory step consumes RAG.
- No hard cross-plan code dependencies except: 112 benefits from 107 landing
  (register the panel as a lazy route); 113's memory step relates to 111.

### Findings considered and rejected (Wave 11)

Vetted against live code and dropped — recorded so they aren't re-audited:

- **DO batch replay sequential loop** (`shard-do.ts:4564-4573`) — correctness-
  required (per-client watermark ordering + idempotency), documented. Not a perf bug.
- **Relay-hub fan-out** — multicast already computes one diff per uniform shape;
  per-socket proxy path is inherently identity-scoped; sends already `Promise.all`-batched.
- **Studio `panels` map rebuilds 35 elements per render** — `createElement` is
  cheap and only the routed subtree renders; folded into 107, not separate.
- **Home fires 5 admin reads on load** — parallel (not a waterfall); admin paths
  are deliberately excluded from the batch transport (security boundary). Coalescing would fight it.
- **Advisor engine per-rule AST re-walk** — false; lints run over a pre-built
  `LintContext`, not re-walking per rule.
- **Codegen incremental discovery / "cache the AST walk"** — REJECTED again (Wave 3
  plan 063 measurement stands: fresh-run cost is ts-morph Project construction, not
  the in-file traversal). 106 targets the _per-feature_ redundancy only, low leverage.
- **Wave-8 test-coverage leads** — REFUTED: workflow fan-out failure-mode tests
  (`packages/workflow/__tests__/fan-out.test.ts`, 15 cases incl. saga rollback) and
  MCP tool authz/error tests (`packages/mcp/__tests__/tools.test.ts`, 18 cases)
  already exist. Codegen case-insensitive-FS collision — not a concern (fixed
  `_generated/*` filenames). Advisor edge-case dedup — out of scope (no advisor
  src change in the delta).
- **Direction items not filed:** inbound mail (already shipped,
  `packages/mail/src/inbound/`); mixed-backend `.global()` D1+Hyperdrive (deliberate
  one-backend-per-app constraint); more OAuth registry providers (folds into 108);
  Studio one-click seed button (minor); AI/rate-limit Studio panels (optional
  follow-ups noted in 112).

## Wave 12 — all-package deep sweep (baseline `b6eb48dcd`, 2026-07-04)

Deep `/improve` pass over **all packages** ("run this command on all packages"),
8 read-only Explore agents (one per audit category), weighted toward the ~33k
changed lines since the Wave-11 baseline `fc9c915b` (the errors layer #101, the
Astro-inspired dev DX #110, the 12 security lints #107, CLI background dev
mode, the studio queue/containers/auth-org panels, `@lunora/angular`). Every
finding was vetted first-hand before planning; excerpts in each plan are from
live reads. Note: the audit began on the working tree at `219eca84b`
(`feat/studio-auth-pages`) and the checkout switched to `alpha` mid-session;
all branch-sensitive excerpts were re-verified on `alpha` at `b6eb48dcd`, which
is the stamped baseline. The user selected **all** fix findings plus two
direction spikes. **Execution 2026-07-04: all 17 plans dispatched in one
parallel wave (13 isolated-worktree sonnet executors; chains 117→119, 121→122,
124→125 sequential within one executor each). Outcome: 15 DONE (incl. 3 spikes;
one REVISE round on 131), 2 BLOCKED (119, 122 — both legitimate STOP
conditions, unblock recipes in their rows). Reviewer re-ran every done
criterion in each worktree before marking DONE. No branch is merged to
`alpha` — that is the user's call.**

Execution notes (Wave 12, for future executors):

- **`pnpm --filter "@lunora/<pkg>..." run build` does NOT walk the workspace
  dependency graph** in this repo (deps are exact-pinned, not `workspace:*` —
  the overrides map them at install time, but the filter graph doesn't
  traverse). Confirmed independently by three executors. Use
  `pnpm run build:packages` locally or `vis run build --query "project=<p>"`
  (vis `dependsOn: ["^build"]` works) — the AGENTS.md guidance overstates the
  `...` form and should be corrected.
- **`pnpm run build:packages` side-effect**: the packem license plugin rewrites
  `packages/cloudflare-access/LICENSE.md` (whitespace). Two executors hit it;
  both correctly reverted before committing. Fix the marker/idempotence
  upstream or expect the dirt.
- **`pnpm --filter @lunora/advisor run lint:eslint` crashes repo-wide**
  (eslint-plugin-n TypeError on `SECURITY_LINT_CANDIDATES.md`) — pre-existing,
  confirmed on two worktrees; lint touched files directly until fixed.
- Merge-order interactions: 117→118 share `advisor/117-119-errors-chain`;
  124→125 share `advisor/124-125-advisor-hygiene`. (129's peer-range docs were
  pre-reconciled to 116's manifests by the thermos pass — no touch-up needed.)

**Thermos review pass (2026-07-04, post-execution):** two thermo reviewers
(branch audit + code quality) swept all 13 branches; verdict "remarkably
clean" — zero P0/P1, no wire break, no security issue. All 9 surviving
findings fixed and committed on their branches: 126 teardown-idiom dedup →
`packages/vite/src/server-close.ts` (`a16fca94`); shared `jsonResponse`
regains the plan's generic `headers?` param, `x-d1-bookmark` back to a
ShardDO-local adapter (`cef72b486`); 131 fixer PoC made self-fixturing in a
mkdtemp copy + playground schema reverted + codegen tsconfig `paths` for the
prototype self-import (`9146c6a1c`); 129 docs peer strings reconciled to 116
(`35a8d9a72`); 116 lockstep guard stands down on non-exact specifiers instead
of false-positively breaking installs (`3955860eb`); 121 studio-unit-step
dist-free invariant pinned in a workflow comment (`b79e9bd87`); and the
audit's own discovery — the CLI insert-conflict solution matcher
`lunora-runtime-unique` aliased the reworded read-side NOT_UNIQUE hint,
rendering wrong remediation for insert conflicts — fixed with a dedicated
write-path body (`ffee9a799` on the errors chain). Adjudicated no-change:
NOT_UNIQUE reword confirmed semantics-preserving (producers untouched);
ENV_INVALID/AUTH_HEADERS_MISSING redaction confirmed consumer-free; 131's
prettier devDep + eslint override recorded in the design doc as spike residue
that dies with the prototypes; pnpm-lock.yaml conflicts on sequential merges
are expected — regenerate via `pnpm install`, never hand-merge.

### Fix plans

| Plan | Title                                                                                       | Category           | Pkg                             | Pri | Effort | Risk | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------- | ------------------ | ------------------------------- | --- | ------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 116  | Repin `@bomb.sh/tab` + lockstep guard + AI-exclude sync + peer drifts                       | deps/dx            | cli / root / 3 pkgs             | P1  | S      | LOW  | DONE — 3 commits ending `0e35ad3f0` on `advisor/116-deps-cerebro-lockstep`; reviewer re-ran gates (guard exit 0 + negative case, 578/578 cli tests, stale excludes gone); guard wired into postinstall. Note surfaced: `workers-ai-provider@3.3.1` still peers `ai ^6.0.0` vs catalog `ai@7.0.14` (warning-level, upstream fix needed — comment deliberately left accurate)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 117  | HTTP-action redaction gap + internal 500 flags + NOT_UNIQUE hint + `lunorash/errors`        | security/bug       | server/errors/lunora            | P1  | S      | LOW  | DONE — `cc47e6143` on `advisor/117-119-errors-chain`; all four deliverables verified in-commit (errorResponse→toErrorBody, ENV_INVALID+AUTH_HEADERS_MISSING internal, read-side NOT_UNIQUE hint, `lunorash/errors` subpath); reviewer re-ran errors 21/21 + server 389/389                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 118  | Unify `jsonResponse` helpers, migrate caught-error envelopes to `toErrorBody`               | tech-debt/security | do/runtime/scheduler/payment/d1 | P2  | M      | MED  | DONE — `59f97bfe6` (same branch); shared `shared/json-response.ts`, zero status-first signatures remain (reviewer-grepped); class-A caught-error sites migrated w/ redaction tests, class-B statics correctly left (reviewer verified all remaining `error:{code` sites are fixed-literal protocol frames); reviewer re-ran do 1027 + runtime 469; executor ran d1 188 + scheduler 102 + payment 96                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 119  | [Investigate] Brand `LunoraError` so foreign errors can't ride the echo path                | security           | errors                          | P3  | S–M    | MED  | DONE — Brand applied: `isLunoraError` now requires `type === "VisulimaError"` (the own-enumerable prop `LunoraError` already set). The earlier ~104-site estimate counted all `new LunoraError(...)` call sites as needing migration, but they already carry the brand via the constructor. Only **1 production site** needed fixing: `packages/do/src/query-args.ts:164` (`invalidCursor` used `Object.assign(new TypeError(), ...)` → now `new LunoraError("BAD_REQUEST", "invalid cursor")`). Added foreign-error regression test, wire-codec round-trip test, updated wire-decoded twin test. Re-ran errors 22/22 + client 341/341 + do 1030/1030 + runtime 470/470 + server 394/394 + lint:types all exit 0 + eslint 0 errors.                                                                                                                                                                                                                                                                                                                   |
| 120  | Background dev: keep tracking a child past the ready timeout (+ pid guard, win32 kill test) | bug                | cli/config                      | P2  | M      | MED  | DONE — `d38389596` on `advisor/120-bg-dev-timeout-orphan`; reviewer re-ran gates (583/583 cli tests, grep clean, tsc clean); race-safe re-point (guarded on own provisional pid), reused `updateDevServerState` (no config change needed); 5 new tests incl. win32 taskkill seam                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 121  | Wire the D1 suite + studio pure-logic tests into local/CI runs                              | tests              | d1/studio/ci                    | P1  | M      | MED  | DONE — `704f00c30` on `advisor/121-122-test-wiring`; reviewer re-ran d1 187/187 (all green, zero fixes needed!) + studio unit 177/177 (17 node files, no hang). Post-review follow-up (user request): the dedicated `test-d1` job was removed again — `project!=d1` dropped from the root `test*` scripts instead, so d1's plain-node mocks project runs inside the existing Test matrix (coverage verified working on node; the workerd project stays gated). **Root cause found for the studio "hang" lore**: `getVitestConfig` spreads a root `include` that overrode project includes → `--project unit` ran ALL ~88 files incl. jsdom `.tsx` under node; fixed with root `include: []`. Build step uses `vis run build --query "project=d1"` (the `pnpm --filter "pkg..."` graph-walk documented in AGENTS.md doesn't work — confirmed by 3 executors independently)                                                                                                                                                                             |
| 122  | Scheduled workerd integration smoke job (allowlist-gated)                                   | tests              | ci                              | P2  | M      | MED  | DONE — implemented as a PR-path `test-workerd` job in `test.yml` (superseding the plan's scheduled non-required workerd.yml design, per the 1.0 roadmap's "make it a required check"): matrix over all 6 gated packages (client/d1/do/runtime/scheduler/storage), `vis run build --query "project=<pkg>"` for deps, then `LUNORA_WORKERD_TESTS=1 pnpm --filter @lunora/<pkg> run test --project workerd` — plain `vitest run`, NO coverage (v8/node:inspector unsupported in pool-workers), 20-min timeout, `fail-fast: false`, wired into `test-required-check`; the same job also runs in the scheduled `nightly.yml`. File selection verified locally via `vitest list --project workerd --filesOnly` (exactly the 10 workerd suites). Runtime verification comes from the first CI run on GitHub — note: the pool DID boot in the 2026-07-16 sandbox and d1 ran 3/4 green with 1 real assertion failure (`migrationRunner applies separate single-statement migrations in order`, expected 5 assertions got 3) — triage that on the first red run |
| 123  | Behavioral tests for the org/team admin surface                                             | tests              | auth                            | P2  | M      | LOW  | DONE — `643937dac` on `advisor/123-auth-org-admin-tests`; 24 new tests (all 8 method groups + teams/org-roles), survivor-row IDOR-shaped assertions verified by reviewer; 180/180 auth tests, tsc clean. Two adapter quirks pinned-as-documented, not fixed: `addMember` on a nonexistent org silently orphans a row (memory adapter has no FK enforcement — worth a runtime-route validation follow-up), and `updateOrganization` synthesizes `{id}`-only success on adapter null-echo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 124  | Advisor hygiene: negative fixtures for 2 lints + `isPublicWrite` helper                     | tests/tech-debt    | advisor                         | P3  | S      | LOW  | DONE — `493a36a28` on `advisor/124-125-advisor-hygiene`; 2 negative fixtures + helper; 2 exact-match replacements, 6 candidates checked-and-left (different predicates, listed); reviewer re-ran 329/329                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 125  | Collapse the 6× arg-derived-access quadruplets into two factories                           | tech-debt          | codegen/advisor                 | P3  | M      | MED  | DONE — `a6040ae86` (same branch); 4/6 feeders factored (vector-namespace + image-delivery-url documented exceptions: semantically different extraction), 6/6 lints via `makeArgumentDerivedSinkLint`; reviewer re-ran codegen 748/748 (goldens byte-identical) + advisor 329/329 with zero existing-test edits. Honest shortfall: ≥50% aggregate line-cut NOT met (feeders −61%, lints −13% — prose is byte-stability-locked); intent (next lint = one config/side) achieved. ⚠ Independent finding, confirmed pre-existing on 2 worktrees: `pnpm --filter @lunora/advisor run lint:eslint` crashes (eslint-plugin-n TypeError on `SECURITY_LINT_CANDIDATES.md`) — repo-wide, needs its own fix                                                                                                                                                                                                                                                                                                                                                       |
| 126  | Vite plugin teardown fires without an httpServer (middleware mode)                          | bug                | vite                            | P3  | S      | LOW  | DONE — `fcdbfef1e` on `advisor/126-vite-teardown-middleware`; reviewer re-ran gates (170/170 vite tests, tsc clean, only the out-of-scope record-WRITE `httpServer?.once("listening")` remains). Close signal chosen with source evidence: Vite `buildEnd` (fires once per close, client-env-filtered; chokidar 4 emits no `close`, ws events exclude it). Executor self-caught a `server.restart()` cross-fire race and keyed pending teardowns by Environment identity, consumed-and-deleted (no leak)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 127  | Queue capture `deadLettered` off-by-one vs CF `max_retries`                                 | bug                | queue                           | P3  | S      | LOW  | DONE — `8065865a9` on `advisor/127-queue-deadletter-flag`; reviewer re-ran gates (35/35 queue tests, grep clean, tsc clean); boundary triple added; scope exact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 128  | AGENTS.md package-table drift (4 missing rows, 10× stale advisor row) + studio docs table   | docs               | root/studio                     | P2  | S      | LOW  | DONE — `8722254ab` on `advisor/128-agents-md-drift`; reviewer re-ran gates (greps, prettier, symlink intact); word-diff confirms only the 4 rows + advisor rewrite are content changes (rest is table alignment); documented in-scope deviation: section prose below the table updated for consistency. Follow-up flagged (not planned): the "Optional-package nav gating" list in studio docs is stale vs `TAB_FEATURE` (missing containers/flags/kv/queues/analytics)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 129  | Author docs-site pages for `@lunora/angular` + `@lunora/nuxt`                               | docs               | angular/nuxt/docs               | P2  | S–M    | LOW  | DONE — `595d68d03` on `advisor/129-angular-nuxt-docs`; reviewer verified prettier + copy-script output + landing diff; executor also ran the full docs prod build (both pages prerendered). ⚠ Merge-order note: after 116 lands, update the two peer-range mentions (angular `@angular/core` peer now incl. ^21/^22; nuxt h3 peer now `^1.15.0`). Follow-up flagged: copy-script `CATEGORY_CONFIG` buckets angular/nuxt (and flags/errors/cloudflare-access) under "Other" in the sidebar                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 130  | [Spike] ctx-db twins shareability inventory (do vs sql-store)                               | tech-debt          | do/sql-store                    | P3  | L      | —    | SPIKE DONE — `51b49b43f` on `advisor/130-ctx-db-twins-spike` (`plans/130-phase0-design.md`, 349 lines). **Verdict: REJECT big-bang merge; STATUS-QUO+ tandem-edit checklist.** Root blocker: deliberate sync `SqlExec` (DO) vs async `SqlCtxExec` (D1/PG/MySQL) divide. Evidence reviewer-verified: 3 of 8 post-scaffold commits touched both files (e.g. `8d94ca17e` 92/89 lines); 1,876 parallel LOC vs 2,882 already shared; test gap do 1,005 vs sql-store 13+15 direct. One P3 follow-up sanctioned: rank strictly-before comparator extraction (~50-100 LOC, characterization tests first) + the checklist header comment                                                                                                                                                                                                                                                                                                                                                                                                                       |

### Direction plans (design/spike)

| Plan | Title                                                         | Category     | Pri | Effort | Risk | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---- | ------------------------------------------------------------- | ------------ | --- | ------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 131  | [Spike] Advisor autofix + suppression/baseline design         | direction/dx | P2  | L      | MED  | SPIKE DONE — `71a17aab4`+`e48c6fcab`+`f1a3b1b87` on `advisor/131-autofix-baseline-spike` (`plans/131-phase0-design.md`, 595 lines, + working fixer/baseline PoCs on the playground; reviewer verified both, one REVISE round to record the cross-check). **Verdict: baseline/suppression FIRST (all 83 lints, cacheKey-keyed JSON w/ audit trail, external `applyBaseline()` wrapper), interactive-confirm ASSISTED fixer second (19 lints, extends Studio's ApplyIndexButton pattern), blind `--fix` last for the 4-lint SAFE set — gated on the index-naming ruling (§5.1 recommends deterministic `by_<snake>` without suffix-stripping; `suggestIndexName` currently emits camelCase).** Classification double-sourced: internal family-uniform pass (4/19/57) + independent 4-session external pass (3/33/44) agree exactly on the SAFE set (§1.5); the plan's own <5-SAFE STOP condition triggered and is recorded as the shaping constraint, not a failure. 4 open questions in §5 |
| 132  | [Spike] Outbound webhook delivery on queue/scheduler/dispatch | direction    | P3  | M–L    | MED  | SPIKE DONE — `f9706e2f5` on `advisor/132-outbound-webhooks-spike` (`plans/132-phase0-design.md` + playground prototype, reviewer re-ran 3/3). **Verdict: buildable with ZERO core changes** — `TriggerCtx` already exposes `scheduler` (verified `types.ts:947-950`); prototype drove real Standard-Webhooks signing (verified by unmodified `@lunora/payment` `verifyStandardWebhook`) through the real SchedulerDO retry/dead-letter/redrive. Phasing: P1 declare+deliver (S–M, extract browser SSRF guard to `shared/` first) → P2 endpoint table + Studio panel → P3 redrive UX. 5 open questions incl. signature-convention choice and per-endpoint secret storage                                                                                                                                                                                                                                                                                                                   |

### Recommended execution order & dependencies

- **P1 first (independent):** 116 (the published-CLI boot-crash regression —
  highest leverage, S), 117 (redaction gap), 121 (D1 tests never run).
- **Errors chain (ordered):** 117 → 118 → 119. 118 copies 117's pattern;
  119's guard change affects both seams' behavior and was validated against their tests (all pass).
- **CI chain:** 121 → 122 (same workflow file; 122 is allowlist-gated with a
  local triage step and must never become a required check).
- **Advisor chain:** 124 → 125 (same package; 125's factories should consume
  124's `isPublicWrite`). 131 coordinates with both (fixer configs slot into
  125's factories) but is a spike and can run any time.
- **Independent:** 120, 123, 126, 127, 128, 129, 130, 132 — any order.
- **Docs pair:** 128 and 129 touch disjoint files; no ordering.

### Findings considered and rejected (Wave 12)

Vetted against live code and dropped — recorded so they aren't re-audited:

- **PERF-01 — codegen discovery repeats the `lunora/` tree-walk ~50× per run**
  (one `listLunoraSourceFiles` disk enumeration per feeder) — REAL but NOT
  WORTH DOING: sub-ms to low-ms on a warm FS cache against a measured
  ~18–20 ms warm-loop budget, and adjacent to the twice-rejected
  incremental-discovery class (Wave-3 plan 063's measurement stands).
- **`@visulima/pail` lockstep** — checked: the CLI's pin `4.0.0-alpha.22`
  EQUALS cerebro alpha.32's peer; only `@bomb.sh/tab` regressed (116 covers
  both going forward via the guard).
- Verified clean this wave (no findings): `pnpm audit` (no high/critical);
  cloudflare-access JWT verification (alg pinned, aud/iss/exp enforced,
  fail-closed); CLI background-dev secret handling (0o600 capture log,
  secret-free `dev.json`, loopback-gated studio token); studio org/queue-replay
  admin surfaces (SENSITIVE_FIELDS stripping, id-only replay); codegen env/secret
  discovery (names only, redacted previews); dispatch runner; mail-preview
  iframe sandbox+CSP; advisor lint claims (spot-checked accurate); runtime
  security-headers resolve-once shape; angular adapter teardown; DO
  queue/mail catchers (bounded retention); no `@lunora/*` dependency cycles;
  `shared/` still zero-import; all 5 framework adapters consume the shared
  client cores (no duplication); `toErrorBody` itself exhaustively tested;
  browser SSRF guard exemplary (30 tests).
- **Studio `buildRouter` unmemoized call** — not a defect; React Compiler is
  enabled for the package (auto-memoized).
- **`fold-container-instances` `>=` tie-break** — degenerate same-epoch-ms
  collision only; not worth a fix.
- **`WorkflowsRestError` embeds upstream response bodies** (non-internal code
  → echoed by design) — informational only; server-to-Cloudflare context,
  unlikely client-facing. Keep in mind when assigning codes to errors that
  wrap third-party response text.
- **CI vis-cache not persisted across runs** — LOW-confidence soft note;
  `vis affected` already scopes work; likely intentional.
- **Studio i18n has only `en.ts`** — weak signal, low value for a local dev
  tool; not filed.
- **Direction items not filed** (already tracked or shipped): SvelteKit /
  SolidStart composition adapters (recorded as a direction option, not
  selected this wave — the Nuxt/Astro pattern is the template when wanted);
  advisor-through-MCP (S–M, not selected); angular adapter parity (roadmap
  choice, each primitive maps to an existing shared core).

## User-requested direction plans (post-Wave 12)

Plans initiated by direct user request rather than an advisor wave.

| Plan | Title                                                          | Category          | Pri | Effort | Risk     | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---- | -------------------------------------------------------------- | ----------------- | --- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 134  | `@lunora/x402` — agentic payments (charge + pay)               | direction         | P2  | L      | MED–HIGH | ALL PHASES SHIPPED (0–6) on `feat/x402-agentic-payments`. **Charge rail**: HTTP-action `withX402` (Phase 1, `3ab9af42d`) + per-procedure `.x402({ price })` with a fail-closed origin-worker 402 seam on `/_lunora/rpc` (Phase 2: 2a `dbcd94a84`, 2b `ab3a10d3`) + **paid MCP tools** — remote Streamable-HTTP transport for `@lunora/mcp` then `createPaidMcpServer`/`paidTool` reusing the Phase-1 charge middleware at the HTTP boundary (Phase 3: 3a `84e4ae642`, 3b `3ffd7717c`) + settlement receipts & opt-in one-way reporting bridge (Phase 6, `34b29c24`). **Pay rail**: three pluggable custody modes — raw-key signer on both families (EVM Phase 4 `8ed00cf2e`, SVM/Solana via `@solana/kit` follow-up `aa196ae98`), **CDP-managed** EVM custody via the optional `@coinbase/cdp-sdk` peer (`c204237dd`), and a **`{ type: "signer" }` escape hatch** taking any provider-built structural signer (`3c9899afc`) — all under a security-critical spend policy (Phase 5, `8ed00cf2e`). **DX wiring**: `@lunora/config` x402 capability inference + binding hints (`1cae1cb62`), codegen `ctx.x402` pay rail on ActionCtx (`49ffa1573`). Reuses `@x402/core` + `@x402/evm` + `@x402/svm` (+ `@x402/fetch`), all Apache-2.0. **Follow-ups resolved (2026-07-10)**: SVM pay custody shipped (`aa196ae98`); user-supplied-signer escape hatch shipped (`3c9899afc`, unlocks Turnkey/Privy/Fireblocks/KMS with no per-provider SDK dep); CDP-managed EVM custody shipped (`c204237dd`, `@coinbase/cdp-sdk@1.51.2` optional peer); advisor lint for unbounded pay policy **obviated** (Phase 5 made `policy` required+non-nullable → compile error + `assertBoundedPolicy` FORBIDDEN, and config lives outside procedure bodies). **Still deferred**: workerd boot-smoke (re-probed 2026-07-10 — pool still hangs on connect-timeout in-sandbox; gated `LUNORA_WORKERD_TESTS=1`); CDP-managed custody **on Solana** (a CDP Solana account is not a `@solana/kit` signer → fails loudly with `NOT_IMPLEMENTED` pointing at the escape hatch; CDP-EVM is shipped). |
| 136  | Incremental external-source table mode (`mode: "incremental"`) | architecture/data | P3  | L      | HIGH     | **DONE & REMOVED** — shipped 2026-07-17 end-to-end: re-widened `ExternalSourceMode` union + `cursor`/`reconcileEveryMs`/`softDeleteColumn` on `ExternalSourceDefinition` (+ `defineSchema` validation) in `@lunora/server`; durable `__lunora_source_cursor` per-(table, shard) watermark table, `materializeExternalRowsIncremental` upsert-only apply, and `pullExternalSourceIncrementalTick` (first-poll/reconcile → full-pull seed+GC, else watermark-bound slice) in `@lunora/do`; codegen poll-loop `mode` branch + IR `hasSoftDelete`; the `external_source_incremental_no_delete_path` STOP lint in `@lunora/advisor`; and the `@lunora/hyperdrive` docs recipe. All four packages build/typecheck/test green (thermos-reviewed: numeric-string cursor compare + unchanged-row content short-circuit fixed). Plan file removed; record in git history.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

| 135 | Road to stable 1.0.0 (umbrella roadmap) | direction | P1 | XL | LOW | TODO — phase/exit-criteria tracker for promoting the alpha channel to a coordinated stable `1.0.0` on `main`. Synthesizes the 2026-07-16 three-track audit (code gaps, test/CI health, docs/release readiness). Key gates: workerd CI job (unblocks 122), plan 095 security fix, plan 090 wire fidelity, exact-alpha sibling peer re-pins, public-API snapshot tooling, docs-nav orphans. See [135-stable-1.0-roadmap.md](135-stable-1.0-roadmap.md). |

## Wave 13 — all-package sweep with Fable 5 (baseline `f41f1823`, 2026-07-18)

Broad `/improve` pass ("check all packages with fable 5"). **8 read-only Explore
agents running Fable 5**, clustered to cover all 47 packages and weighted toward the
**5 brand-new, never-audited packages** (`agent`, `x402`, `replica`, `fingerprint`,
`react-native`) plus the ~388 commits of delta since the Wave-12 baseline
`b6eb48dcd`. Each agent was given the prior-wave shipped/rejected set so it wouldn't
re-report known false positives. A mid-run session-limit reset interrupted 6 of 8
agents; they were resumed from transcript and finalized. **Every headline finding was
vetted first-hand against live code** before planning (excerpts in each plan are from
those reads); the Fable agents were accurate on all spot-checked items. The user
selected **all four tiers** for planning. All plans **TODO — none executed yet.**

Densest yield came from the new packages, as expected. Confirmed-clean (no findings):
`auth`/`ratelimit`/`mail`/`cloudflare-access`/`storage`; `errors`/`values`/`bindings`/
`container`/`queue`/`workflow`/`hyperdrive`/`browser` (shipped hardening); `mcp`/
`advisor`/`seed`/`db`/`astro`/`nuxt`; x402 private-key handling; the vendored
`fingerprint` SHA-256 (executed byte-for-byte vs `node:crypto` — matches); replica SQL
parameterization.

### Plans

| Plan | Title                                                                       | Findings                      | Category     | Pkg             | Pri   | Effort | Risk    | Status |
| ---- | --------------------------------------------------------------------------- | ----------------------------- | ------------ | --------------- | ----- | ------ | ------- | ------ |
| 138  | Close mask() oracle on where-batch-writes + `baseWhere` reads               | SERVER-01/02                  | security     | server          | P1    | S      | LOW     | TODO   |
| 139  | Fail RAG lexical store closed on all non-empty filters                      | AI-01                         | security     | ai              | P1    | S      | LOW     | TODO   |
| 140  | Harden x402 spend policy (asset, per-run race, unbounded allowlist)         | X402-01/02/03                 | security     | x402            | P1    | S–M    | MED     | DONE   |
| 141  | Bind agent tool-approval to thread+call; close id-less concurrency bypass   | AGENT-01/02                   | security     | agent           | P1    | S      | LOW     | TODO   |
| 142  | Reconcile `triggers.crons` on deploy/prepare (crons never fire in prod)     | CLI-01                        | bug          | cli             | P1    | M      | MED     | TODO   |
| 143  | External-source ingest correctness (Date/bigint brick + edges)              | DO-01…05                      | bug          | do              | P1/P3 | M      | LOW–MED | TODO   |
| 144  | Scheduled actions get an ActionCtx in the harness                           | TESTING-01                    | tests        | testing         | P2    | S      | LOW     | TODO   |
| 145  | x402 charge: settle before committing paid mutations; deliver receipt sink  | X402-04/05                    | security/bug | x402            | P2    | M      | MED     | TODO   |
| 146  | Replica event-log: atomic/idempotent append, per-materializer watermark     | REPLICA-02/03/04              | bug          | replica         | P2    | M      | MED     | TODO   |
| 147  | Bound agent memory hot-path `.collect()`s (graph seeds, thread messages)    | AGENT-03/04                   | perf         | agent           | P2    | M      | LOW–MED | TODO   |
| 148  | Sourced-DO alarm re-arms at next-due, not the 2 s floor                     | DO-06                         | perf         | do/codegen      | P3    | S–M    | MED     | TODO   |
| 149  | Agent-chat optimistic echo for repeated prompts (5 adapters)                | REACT-01                      | bug          | react+4         | P2    | S–M    | LOW     | TODO   |
| 150  | Port pagination reentrancy guard to Svelte/Solid (sub leak)                 | SVELTE-01/SOLID-01            | bug          | svelte/solid    | P2    | S      | LOW     | TODO   |
| 151  | Surface failures on Studio org-admin row actions                            | STUDIO-01                     | bug          | studio          | P2    | S      | LOW     | TODO   |
| 152  | Sanitize `fingerprintError` outputs (NUL/surrogate) + bucketer              | FP-02/03                      | bug          | fingerprint     | P3    | S      | LOW–MED | TODO   |
| 153  | Codegen agent-discovery guards (uniqueness/wrapped/cron/shadow)             | CODEGEN-01…04                 | bug          | codegen         | P3    | S–M    | LOW–MED | TODO   |
| 154  | CLI correctness cluster (env-set dup, entry probe, loopback, PM cast)       | CLI-02…05                     | bug          | cli             | P3    | S      | LOW     | TODO   |
| 155  | Dedup detectors/constants across config & codegen                           | CONFIG-01/02/03, CODEGEN-05   | tech-debt    | config/codegen  | P3    | S–M    | LOW–MED | TODO   |
| 156  | Fix Creem email-recovery cross-tenant customer binding                      | PAY-01                        | security     | payment         | P2    | S      | LOW     | TODO   |
| 157  | RAG hybrid-scoring cliff, inert text-store importance, fail-fast index      | AI-02/03/04                   | bug/perf     | ai              | P3    | S–M    | LOW     | TODO   |
| 158  | Small client/react/rn fixes (reset, stream leak, resubscribe, native voice) | CLIENT-04/05, REACT-02, RN-01 | bug/perf     | client/react/rn | P3    | S      | LOW     | TODO   |
| 159  | Replica remaining correctness (adapter/replay/growth/EventSource/sync)      | REPLICA-01/05/06/07/08/09     | bug          | replica         | P3    | S–M    | LOW–MED | TODO   |
| 160  | Consolidate the ~2k-line voice/agent surface across 5 adapters              | CLIENT-06                     | tech-debt    | client+5        | P3    | M–L    | LOW–MED | TODO   |
| 161  | Agent misc: discriminate as-tool create errors; container-gate scope        | AGENT-05/06                   | bug/docs     | agent           | P3    | S      | LOW     | TODO   |
| 162  | crossTabSync leader demotion + offline-queue FIFO; relay design             | CLIENT-01/02/03               | bug/design   | client          | P3    | M–L    | MED     | TODO   |

### Recommended execution order & dependencies

- **Tier 1 security first (independent, mostly S):** 138, 139, 140, 141, 156 — the
  HIGH-confidence, small-fix, security-critical set. Land in any order.
- **Silent prod failures next:** 142 (crons never deploy), 143 (external-source
  bricks on Date/bigint — Step 1 is the critical one), 144 (harness fidelity).
- **Then perf + user-visible:** 147, 148, 149, 150, 151, 152.
- **DX/tooling + tail:** 153, 154, 155, 157, 158, 159.
- **Dependencies / interactions:**
    - **149 (REACT-01), 150 (SVELTE/SOLID-01), 158 (RN-01) are point-fixes subsumed by
      160 (CLIENT-06 consolidation).** If 160 lands _after_ them, fold the fixes into
      the shared cores; if 160 lands _first_, apply the point-fixes in the single shared
      copy. Each plan's STOP conditions call this out — check the tree state first.
    - **148 pairs with 143** (both external-source, different concerns — cadence vs.
      content) but is independent; land in either order.
    - **146 complements 159** (both replica; 146 = write/recovery path, 159 = the rest).
    - 153, 148, 155 touch codegen goldens — regenerate and keep the diff intended-only.

### Findings considered and rejected / by-design (Wave 13)

Vetted and NOT filed as standalone plans (recorded so they aren't re-audited):

- **AGENT-06 (container gate covers only `/exec`)** — the docstring itself concedes a
  plain `fetch` to another route runs unattended, so it's partly by-design. Folded
  into **plan 161** as a harden-the-default-or-document step, not a standalone bug.
- **PAY-02 (webhook unknown subscription status stays entitling)** — largely
  by-design and bounded by the scheduled `reconcile` sweep; the same asymmetry exists
  in the prior-vetted Stripe/Polar adapters. Not planned (noted as a possible
  fail-closed follow-up in the audit).
- **STUDIO-02 (DLQ-reliability predicate duplicated: Queues panel vs advisor lint)** —
  ~5 lines each, currently identical; "not worth consolidating yet" given cross-package
  coupling cost. Recorded in **plan 151**'s notes so the drift risk is known.
- **Confirmed clean under direct read** (no plan): auth session/rate-limit/OAuth,
  cloudflare-access JWT (alg pinned, aud/iss/exp, fail-closed), mail inbound (spoofable
  sender documented + gated), storage signed-URL/key validation, ratelimit fail-closed
  middleware; the errors/values/bindings/container/queue/workflow/hyperdrive/browser
  deltas (shipped hardening); MCP write/agent gating (fail-closed at advertise +
  dispatch); advisor lints (conservative, fail-silent on absent evidence); seed
  determinism + FK topo order; x402 private-key handling + 402 fail-closed seam +
  `usdToAtomic` exactness; the vendored `fingerprint` SHA-256 (executed vs node:crypto);
  replica SQL parameterization + DO generic-500 error handling.

### Not audited this pass

- **Direction / roadmap** (features, what to build next) — out of scope for this
  correctness/security/perf/tests/tech-debt sweep. Run `/improve next` for a grounded
  direction pass.
- `runtime`/`sql-store`/`d1`/`scheduler`/`dispatch` deltas were scanned for the audit
  categories but not deep-audited (DO/external-source got the depth); no verified
  findings surfaced there.

### Execution status (2026-07-18)

Executed via isolated-worktree Sonnet executors. An initial 9-way-parallel attempt
hit **pnpm-store install contention** (concurrent cold installs raced on shared store
files; one worktree was corrupted) — re-run **serially, 2–3 concurrent, warm cache**,
which was reliable. Every diff was reviewer-verified (scope, correctness, re-run gates).
**`alpha` was never touched** (still at `f41f1823`). Each branch below is one clean
commit on `alpha`, stripped of the stray local `chore(release)` version-bump stack that
`multi-semantic-release` generated inside worktree builds.

| Plan | Status     | Branch (`advisor/…`)                 | Gate result                                                                                   |
| ---- | ---------- | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| 138  | ✅ DONE    | `138-mask-oracle`                    | server 419/419                                                                                |
| 139  | ✅ DONE    | `139-rag-lexical-rls`                | ai 90/90                                                                                      |
| 140  | ✅ DONE    | `140-x402-spend-policy`              | x402 97/97 — X402-01/02/03 all done (X402-01 via the revised per-asset-decimals approach)     |
| 141  | ✅ DONE    | `141-agent-approval-concurrency`     | agent 269/269                                                                                 |
| 142  | ✅ DONE    | `142-cron-reconcile`                 | config 443 / cli 671 / vite 178                                                               |
| 143  | ✅ DONE    | `143-external-source`                | do 1102/1102                                                                                  |
| 144  | ✅ DONE    | `144-harness-scheduled-action-ctx`   | testing (lint-verified)                                                                       |
| 145  | ✅ DONE    | `145-x402-charge-settlement-receipt` | x402 81/81                                                                                    |
| 146  | ✅ DONE    | `146-replica-event-log`              | replica 233/233 — ⚠ source carries pre-existing ESLint errors (lint:types+tests green)        |
| 147  | ✅ DONE    | `147-agent-memory-hotpath`           | agent 266/266                                                                                 |
| 148  | ✅ DONE    | `148-sourced-do-alarm-nextdue`       | do 1095 / codegen 829                                                                         |
| 149  | ✅ DONE    | `149-optimistic-echo`                | react 132 / vue 90 / solid 79 / svelte 85 / angular 88                                        |
| 150  | ✅ DONE    | `150-pagination-guard`               | svelte 85 / solid 79 (solid = safe hardening)                                                 |
| 151  | ✅ DONE    | `151-studio-org-admin-errors`        | studio (lint-verified)                                                                        |
| 152  | ✅ DONE    | `152-fingerprint-sanitize`           | fingerprint (lint-verified)                                                                   |
| 153  | ✅ DONE    | `153-codegen-guards`                 | codegen 838/838                                                                               |
| 154  | ✅ DONE    | `154-cli-correctness`                | cli 676/676                                                                                   |
| 155  | ✅ DONE    | `155-config-codegen-dedup`           | config 453 / codegen 829                                                                      |
| 156  | ✅ DONE    | `156-creem-cross-tenant`             | payment (lint-verified)                                                                       |
| 157  | ✅ DONE    | `157-rag-scoring-indexing`           | ai 91/91 — AI-02 diagnosis corrected in-flight                                                |
| 158  | ✅ DONE    | `158-client-small`                   | client 392 / react 134                                                                        |
| 159  | ✅ DONE    | `159-replica`                        | replica 246/246 — REPLICA-01 fixture not run vs real sqlite-wasm; REPLICA-06 partial per STOP |
| 161  | ✅ DONE    | `161-agent-misc`                     | agent 267/267                                                                                 |
| 162  | ✅ DONE    | `162-crosstabsync`                   | client 391/391 — CLIENT-01 = design doc (`162-phase0-crosstabsync-design.md`)                 |
| 160  | ⏸ DEFERRED | —                                    | L consolidation; subsumes 149/150/158 — run after those merge                                 |

**Notes for the maintainer merging these:**

- All 24 branches are independent single-commit deltas on `alpha`; merge in any order.
  Same-package branches will textually conflict (e.g. agent: 141/147/161; ai: 139/157;
  x402: 140/145; replica: 146/159; client: 158/162 + 149/150) — sequence those.
- **160** is the only unfinished item. 140's X402-01 asset check landed via the revised
  per-asset-decimals approach: `SpendPolicy.allowedAssets` (each entry carrying its own
  `decimals`, defaulting to a hand-mirrored canonical-USDC table), the policy-wide
  `decimals` field refused outright, and the per-run ledger locked to one decimal
  precision per run.
- **146** needs a small ESLint cleanup on its source (non-null assertions, JSDoc, complexity).

## Wave 14 — competitive parity (baseline `70331e9b`, 2026-07-21)

User-requested gap pass over the whole repo vs **Convex, Supabase, Firebase**
(and the wider field: InstantDB, Zero, Triplit, ElectricSQL, PowerSync,
Liveblocks, PartyKit, Wasp). Builds on the two prior competitive passes (Wave 5 =
PartyKit, Wave 6 = workflais). Findings were grounded against `packages/*/src`,
so **verified non-gaps are excluded**: full-text search (`.searchIndex()` /
`withSearchIndex()`), vector/RAG (`@lunora/ai/rag`), cron (`@lunora/scheduler`),
storage (`@lunora/storage`), offline/local-first (`@lunora/replica`,
`@lunora/db`), presence (`whisper` + `usePresence`), flags (`@lunora/flags`),
workflows + fan-out (`@lunora/workflow`). Full analysis: `.tmp/competitive-gap-analysis.md`
(gitignored, not committed). All plans **TODO — none executed yet.**

**Routing rule.** Every gap lands in exactly one bucket: **FRAMEWORK** (a plan
below), **CLOUD** (owned by `apps/cloud/ROADMAP.md` — managed hosting, hosted
dashboard, retained observability, preview envs, backups/PITR, managed
multi-region, templates/marketplace, warehouse connectors — _not_ re-planned
here), or **NON-GOAL** (a documented design boundary: no arbitrary external SQL /
ad-hoc cross-dataset joins; RPC-first not REST-first; cross-shard writes eventual
unless plan 168 lands). Publishing the NON-GOALs as a docs page is the cheapest
trust win — boundaries read as deliberate, not missing.

### Plans (FRAMEWORK-bucketed gaps)

| Plan | Title                                                                                                                                                          | Category     | Pkg          | Pri | Effort | Risk | Status                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------ | --- | ------ | ---- | ---------------------------------------------------------------------- |
| 164  | Non-TypeScript client SDK (Swift _or_ Python) — prove the wire protocol isn't TS-bound; biggest ceiling vs Convex                                              | feat         | client (new) | P2  | L      | MED  | SHIPPED                                                                |
| 165  | `@lunora/push` — Web Push (VAPID) → FCM/APNs; grep-confirmed zero push code today                                                                              | feat         | push (new)   | P2  | L      | MED  | SHIPPED                                                                |
| 166  | Enterprise auth: SSO + SCIM — `@better-auth/sso` + `@better-auth/scim` (MIT); OIDC/SCIM-Users LOW, SAML-on-workerd is the risk                                 | feat         | auth         | P2  | M–L    | MED  | 🔶 PHASE 1a SHIPPED (OIDC SSO + SCIM; incl. better-auth 1.7 migration) |
| 167  | Opt-in public REST/GraphQL surface — extend the existing OpenAPI/OpenRPC spec (`cli/api-spec.ts`) for non-TS/interop, RLS-enforced                             | feat         | runtime/cli  | P3  | L      | MED  | SHIPPED (REST; GraphQL Phase 2 demand-gated)                           |
| 168  | Cross-shard transaction story — **design spike first** (saga vs 2PC vs documented boundary+lint); no code until ratified                                       | architecture | do/runtime   | P2  | XL     | HIGH | TODO                                                                   |
| 169  | `@lunora/collab` (CRDT) — Yjs persistence + awareness over `ShardDO` + `whisper`; reuse `y-partyserver` (ISC); demand-gated                                    | feat         | collab (new) | P3  | XL     | MED  | TODO                                                                   |
| 170  | Continuous CDC export tap (op-log → external sink) — the streaming counterpart to CDC-in; snapshot export/backup already exist                                 | feat         | runtime/do   | P3  | L      | MED  | SHIPPED (tap + webhook/R2 sinks; warehouse connectors = Cloud)         |
| 171  | "Design boundaries / non-goals" docs page — state the NON-GOAL bucket plainly (no arbitrary SQL, RPC-not-REST-first, cross-shard eventual); cheapest trust win | docs         | docs         | P2  | S      | LOW  | SHIPPED                                                                |

### Studio / surface tails (Wave 14 — ✅ all shipped)

The "Surface & docs" Phase-2 work that trailed the shipped plans is now complete,
so these plans are fully done and their files removed:

- **174 auth audit** ✅ — plus the Studio "Auth audit" page and the gated
  `__lunora_admin__:getAuthAuditLog` RPC (D1-backed, admin default-closed,
  codegen-wired `authAuditReader`).
- **177 health** ✅ — plus the Studio deployment-health panel (fetches
  `/_lunora/health`), the `production-checklist.mdx` section, and the opt-in
  `lunora verify --health-url` probe.
- **165 push** ✅ — plus the Studio Notifications devices page, the gated
  `__lunora_admin__:listPushSubscriptions` RPC (secrets stripped), and the
  `examples/notify-demo/` example declaring `lunora/notify.ts`.

### Considered / newly surfaced (Fable 5 deep pass, 2026-07-21)

**The three follow-up gaps — verified:**

- **A/B testing / experimentation** — _real but narrow._ `@lunora/flags` already
  serves variants + provider-side percentage rollouts; only the experiment layer
  is missing (log `details.variant` exposures → `@lunora/bindings/analytics` + a
  Studio results view). Only Firebase (of the three) has it. **M · P3 · FRAMEWORK**
  (thin flags extension; a heavy stats engine stays NON-GOAL/CLOUD).
- **Product analytics** — _partial._ Ingestion exists (`@lunora/bindings/analytics`
  typed `track`/`writeDataPoint` + SQL-API + Studio panel), but Analytics Engine is
  sampled with ~3-month retention — the wrong substrate for canonical product
  analytics (no taxonomy/sessions/funnels/retention). Only Firebase ships a
  first-party product. **P3 · CLOUD** primarily (retained, unsampled = hosted);
  optional small FRAMEWORK event-helper slice. Near-term answer: document a
  PostHog integration.
- **Server-side DB triggers / webhooks** — _NOT a gap (core); small (packaging)._
  Triggers already ship: `defineTable().triggers()` — before/after × insert/update/
  delete, typed `previous` row, `before*` aborts the write, `TriggerCtx = {db,
scheduler}` (`server/src/schema.ts`, `types.ts:1104`) — stronger than Convex's
  helper. Plan 133 is unrelated (CDC-_in_). The only open sliver is **packaged
  outbound HTTP webhooks**, already spiked as **plan 132** (Standard-Webhooks over
  `TriggerCtx.scheduler` + SchedulerDO retry/dead-letter, zero core changes).
  **S–M · P2 · FRAMEWORK** = execute plan 132.

**Additional gaps found by the deep gap-hunt (all repo-verified):**

| Plan           | Gap                                                            | Competitors with it                                              | Lunora today                                                                               | Sev      | Bucket                      |
| -------------- | -------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------- | --------------------------- |
| 172 ✅ SHIPPED | **Geospatial indexing / queries** (`near`, within-radius)      | Convex (geo component), Supabase (PostGIS), Firebase (geohash)   | none — zero geo code in `packages/server/src`                                              | **HIGH** | FRAMEWORK                   |
| 173 ✅ SHIPPED | **Client-side upload SDK** (progress, pause/resume, resumable) | Firebase, Supabase (TUS), Convex                                 | server R2 multipart + presigned exist; only admin-gated client upload, no `useUpload`      | MED      | FRAMEWORK                   |
| 174 ✅ SHIPPED | **Auth/security audit trail**                                  | Supabase (`auth.audit_log_entries`), Firebase, Convex (paid)     | admin-state audit log exists (`do/audit-log.ts`) but no auth-event recording               | MED      | FRAMEWORK                   |
| 175 ✅ SHIPPED | **Schema-level TTL / auto-expiry**                             | Firebase (Firestore TTL), Supabase (pg_cron) — Convex also lacks | no `.ttl()`; only presence-heartbeat TTL. DO alarm infra (`do/triggers.ts`) already exists | LOW–MED  | FRAMEWORK                   |
| —              | **Client integrity / attestation** (App Check)                 | Firebase only                                                    | none; Turnstile/WAF already front every Worker                                             | LOW      | CLOUD / NON-GOAL → plan 171 |

**Verified non-gaps** confirmed by the deep pass (Lunora already ships — do not
re-file): passkeys / anonymous / magic-link / email-OTP / phone / 2FA / SIWE /
OIDC-provider / captcha / impersonation / orgs-RBAC (`auth/plugins.ts`);
data-residency (DO jurisdiction pinning); aggregation (`count`/`aggregate`/
`groupBy` + cross-shard rank); custom HTTP endpoints (`httpAction`/`httpRouter`);
soft-delete + cascade/restrict/set-null + unique indexes + typed enums; Studio SQL
editor; snapshot export/import + **backups with PITR restore** + CSV transfer
(CLI); online batched migrations; paginated/infinite live queries; flag targeting +
percentage rollouts; server-side R2 multipart uploads.

### Competitor facts (verified July 2026 — closes `.tmp` §5)

- **Convex SDKs**: TS/React/React-Native, Python, Rust, Swift, Kotlin — **no Go**;
  streaming export via **Fivetran (Pro)**. Confirms plan 164 (Lunora is TS-only).
- **Supabase**: branching GA (2.0 drops the Git requirement, paid/hourly); read
  replicas (≤2, paid, geo-routed GETs); PostgREST + pg_graphql first-party (with a
  2026 breaking change — `public` no longer auto-exposed). Confirms plans 167/012-branching.
- **Firebase**: FCM still the only supported push path (legacy APIs shut down
  2024-07); **Analytics (GA4) + A/B (Remote Config experiments) both still
  first-party**. Confirms plan 165 + gap α.

### Reuse — `@visulima/*` packages (2026-07-21)

The visulima ecosystem (same author; `fetch` + Web-Crypto-first, Cloudflare-aware)
already covers several of these gaps — **reuse over rebuild**:

| Plan / need    | Reuse                                                                                                           | What it saves                                                                                                                | Edge-safe?                                                             |
| -------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **165** push   | **`@visulima/notification`**                                                                                    | whole multi-channel engine (Web Push, FCM, Expo, APNs, SMS, chat, in-app inbox, webhook) + routing / retry / circuit-breaker | Web Push + FCM ✅; **APNs needs Node http2**, queue adapters Node-only |
| **173** upload | **`@visulima/storage-client`** (+ `@visulima/storage` cloudflare handler)                                       | `useUpload`/multipart/TUS hooks w/ progress + pause/resume; R2 + presigned server                                            | ✅ (hooks want TanStack Query)                                         |
| **174** audit  | **`@visulima/redact`** (already in `do`) + **`@visulima/secret-scanner`**                                       | PII/secret redaction + leak scan                                                                                             | ✅                                                                     |
| **167** REST   | **`@visulima/pagination`**; `@visulima/jsdoc-open-api` (weak — Lunora derives the spec from codegen, not JSDoc) | pagination helpers; OpenAPI gen                                                                                              | build-time                                                             |

New opportunities the catalog surfaces (not previously listed):

- **`@visulima/email-verifier`** + **`disposable-email-domains`** + **`free-email-domains`**
  → `@lunora/auth`: block throwaway signups / validate email (domain lists are
  pure-data / edge-safe; MX verify needs DNS). → **plan 176 ✅ SHIPPED**.
- **`@visulima/health-check`** → production-readiness health/metrics endpoint
  (feeds the production-checklist). → **plan 177 ✅ SHIPPED**.
- **`@visulima/content-safety`** → optional moderation for user-generated content
  (multi-language filtering) — a `ctx` helper or small package. _(not yet a plan)_
- **`@visulima/bytes`** → `encodeWire` Uint8Array handling (plan 164 SDK / storage).
- Wider reuse of ones already in the tree: **`@visulima/error`/`ono`/`source-map`**
  (`@lunora/errors`, vite-overlay), **`humanizer`** (Studio formatting),
  **`inspector`** (Studio debug), **`iso-locale`** (time/locale).

**No visulima reuse** for: 172 geospatial, 175 TTL, 168 cross-shard txn, 169 CRDT
(that's `y-partyserver`). **`@visulima/workflow`** exists but `@lunora/workflow` is
deliberately on Cloudflare Workflows — different substrate, not a reuse.

### Notes

- **166 Phase 1a shipped** (`feat/166-sso-scim`): `scim` on the curated plugin surface,
  `sso` behind `@lunora/auth/plugins/enterprise` as an optional peer (its samlify tree
  should not be in every install). Shipping it required migrating the whole better-auth
  stack to **1.7.0-rc.2**: `@better-auth/scim` < 1.7.0-beta.4 carries a HIGH advisory
  (GHSA-j8v8-g9cx-5qf4) that no 1.6.x escapes. That migration also re-homed removed
  public surface (`oidcProvider` → `oauthProvider`, `withMcpAuth` → `requireMcpAuth`,
  `genericOAuthClient`/`oidcClient`/`scimClient` dropped) and fixed the expo bridge the
  old pin existed to protect. 1.7.0 is NOT GA — revisit the prerelease pins on release.
  Phase 2 (SCIM Groups) is obsolete: 1.7 ships `/Groups` upstream. The plan's risk split was
  wrong in one respect — `@better-auth/sso` _statically_ imports `samlify` +
  `node:crypto`'s `X509Certificate`, so the OIDC-only path drags the SAML tree in and
  the load question gated both halves. A gated workerd suite answers it GO (the
  plugins boot and construct in the real runtime). Still open: the SAML **ACS
  execution** spike (CPU cost of pure-JS RSA), a real Okta/Entra tenant, and
  `lunoraAuthAdapter` (vs `memoryAdapter`) compat.
- **166 is LOW-risk only for the OIDC-SSO + SCIM-Users half** (Fable 5 verified:
  `@better-auth/sso` + `@better-auth/scim`, first-party MIT, edge-safe on that
  path). **SAML is the risk** — `samlify` → `xml-crypto`/`node-rsa` are Node-only,
  and upstream better-auth#10343 flags SAML ACS as a poor fit for Worker CPU
  budgets (pluggable remote executor proposed, PR #10347 unmerged). Plan 166 is
  re-split into Phase 1a (SSO+SCIM, do first) and Phase 1b (SAML, gated on a
  workerd spike); risk raised LOW → MED.
- **168 is decision-first** — the spike (`plans/168-phase0-design.md`, to be
  filed) must decide whether cross-shard atomicity is a real need or a
  documented boundary. Do not write transaction code before it concludes.
- **169 and 170 are demand-gated** — file, don't build until a design partner
  needs collab / warehouse export. 170 is scoped narrowly: the snapshot NDJSON
  exporter (`runtime/export-stream.ts`) and R2 backup already ship; only the
  continuous change tap is missing.
- **164 has a prerequisite** — formalize the wire protocol as a
  language-independent spec + conformance fixtures before writing the SDK.

## Wave 15 — competitive gap analysis (Prisma Studio, baseline `865a9a4c`, 2026-07-28)

A requested pass over `packages/studio`, compared against
[prisma/studio](https://github.com/prisma/studio) (`@prisma/studio-core`, OSS),
grounded against that repo's source tree and its normative `Architecture/*.md`
docs rather than its README. Prisma Studio is a **database** tool with 7 views
(`table`, `sql`, `schema`, `migrations`, `queries`, `console`, `stream`);
`@lunora/studio` is a full backend console with ~27 feature areas, so we are a
superset almost everywhere. The gaps below are the places where their narrower
scope bought deeper polish.

**Verified non-gaps (excluded).** Schema visualization (`@xyflow/react` diagram +
export + editor overlay), row virtualization, CSV/JSON/**SQL** export (they do
CSV/JSON only), column visibility, EXPLAIN, schema-aware SQL autocomplete, saved
queries, FK traversal, facets, staged edits, cascade preview, row generation,
shard explorer, mask policies. Their `stream` view is Prisma-Postgres-specific
(our analog is the logs/subscriptions panels).

| Plan | Title                                                                                                   | Category | Pkg               | Pri | Effort | Risk | Status                                                                                                                                                                                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------- | -------- | ----------------- | --- | ------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200  | Studio migration & schema-version visualizer — ledger + diff canvas; the headline gap                   | feat     | do/codegen/studio | P2  | L      | MED  | DONE & REMOVED — `__lunora_schema_history` ledger + timeline + diff on the React Flow canvas; the diff engine moved to top-level `shared/` so the drift gate and the Studio classify a change identically.                                                                                                                                      |
| 201  | Studio SQL editor diagnostics — inline lint before Run, no CodeMirror adoption                          | dx       | studio/do         | P2  | M      | LOW  | DONE & REMOVED — inline lint before Run (rejected verbs, unknown tables/columns, syntax, full-scan plans) via an overlay + problems row. CodeMirror NOT adopted, as the plan required.                                                                                                                                                          |
| 202  | Studio AI layer — one host-supplied `llm` hook (NL→SQL + error correction, NL→filter, chart config)     | feat     | studio            | P3  | L      | MED  | DONE & REMOVED — product decision landed: the model runs server-side on the app's OWN Workers AI binding, the browser never sees a key, and chart inference sends column names/types/row-count only (asserted by a test). Generated SQL passes the same read-only gate as hand-typed SQL and lands unexecuted.                                  |
| 203  | Time-ranged statement-level query insights — bucket the metrics we already collect; add p95 + live tail | feat/obs | do/studio         | P2  | M      | LOW  | DONE & REMOVED — 1m/5m/15m/1h ranges over time-bucketed statement metrics, p50/p95 beside the mean. Follow-on (AI recommendations over the series) deliberately not started.                                                                                                                                                                    |
| 204  | Studio operation console — a tape of what Studio itself issued                                          | dx/obs   | studio            | P3  | S–M    | LOW  | DONE & REMOVED — operation tape recorded through a Proxy over the admin client, so coverage is true by construction rather than by remembering to call a helper.                                                                                                                                                                                |
| 205  | Studio data-grid parity + URL state — pinning, match highlight, typed search, column virtualization     | dx/perf  | studio/do         | P2  | M–L    | LOW  | DONE & REMOVED — pinning, match highlighting, typed date search, column windowing, reverse-relation counts, URL state. **Infinite scroll: decided against** — pagination gives a stable position, an exact count, and export semantics that mean "these rows"; the perf motive was the vertical axis, which row virtualization already answers. |

### Notes

- **200 is the headline gap and the cheapest big win**, because three of its four
  pieces already exist: the structural snapshot format and its `safe`/`breaking`
  diff (`codegen/src/schema-drift.ts`), and the React Flow canvas
  (`studio/src/features/schema/`). What is missing is **history** — the drift gate
  keeps exactly one committed baseline at `lunora/.lunora-schema.json` and
  overwrites it. The plan makes the DO the ledger (a reserved
  `__lunora_schema_history` table appended by `runShardMigrations`) so the view
  works in production, and moves the pure diff into top-level `shared/` so
  codegen and studio can both use it without a dependency edge.
  **Do not conflate the two ledgers**: `defineMigration` is hand-written _data_
  migration, schema is applied at runtime from `defineSchema`. The plan shows
  schema versions on the timeline and correlates data migrations into it.
- **203's framing was corrected mid-analysis.** The first read said "we have no
  query insights"; that is wrong. `do/src/query-metrics.ts` already records
  per-normalized-statement aggregates into `__lunora_metrics_queries`, surfaced
  via `getMetrics().queryStats` in a "Query insights" tab
  (`studio/src/features/reports/metrics-panel.tsx:123`). They are **lifetime
  cumulative counters with a mean and no time axis**, so the real work is
  time-bucketing (the `function-metrics.ts` `__lunora_metrics_buckets` pattern,
  applied to statements) plus percentiles and a range selector.
- **201 carries a design decision worth preserving**: the SQL editor is a plain
  `<textarea>` with a hand-rolled gutter and autocomplete, not CodeMirror.
  Adopting CodeMirror to get squiggles would be a bundle-size decision affecting
  every embedded Studio and would obsolete two working, tested components — the
  plan renders diagnostics via an overlay + a problems row instead, and makes
  "adopt CodeMirror" a STOP-and-report, not an improvisation.
- **202's product decision, as landed**: the model runs server-side on the
  app's own Workers AI binding, so no key or provider ships in the browser and
  no row values leave the machine (chart inference sends column names, types,
  and the row count — asserted by a test). Every affordance is hidden when the
  deployment has no `AI` binding, mirroring how `schemaEditable` gates the
  schema-authoring overlay.
- **204 has a single clean choke point** — every Studio admin call flows through
  `studio/src/lib/internal.ts` + `hooks/use-admin-query.ts`. It records operation
  _shapes_ (function, shard, argument summary, duration, outcome), never row
  payloads, and complements the server-side audit log rather than duplicating it.
- **205 protected what we already do better** (cascade preview, staged edits,
  facets, masking, SQL export) as explicit non-goals. **Infinite scroll was
  decided against**: pagination gives a stable position, an exact count, and
  export semantics that mean "these rows". The perf motive behind the other
  tradeoff was the vertical axis, which row virtualization already answers.
- **The wave's react-doctor debt is closed.** The sweep that ended the wave took
  `packages/studio` from 232 findings to 0, but ten `no-giant-component`
  findings were _suppressed_ rather than fixed, since splitting a panel is its
  own refactor. PR #237 did the splits (all ten now 195–294 lines, from
  306–714) and deleted every suppression, closing
  [#230](https://github.com/anolilab/lunora/issues/230). Two findings worth
  carrying forward: `grid-features.tsx` holds a second `CONTROL_BTN` without the
  `aria-pressed:*` variants (a trap for anyone moving toolbar markup), and
  grouping refs into one prop makes the React Compiler bail out of a whole
  component — pass refs individually.

### Recommended execution order

Spent — the whole wave shipped in one branch (PR #229).

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
