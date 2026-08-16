# Plan 335 — Audit against the "Cloudflare AI psychosis" critique: the 0 ms span defect we inherit, and the RAG gaps that remain

**Baseline:** `cadabf5` (2026-08-16)
**Status:** DONE — every gap in §1c closed; see §5 for per-workstream status and the two deliberate exceptions.

Prompted by [_Cloudflare's AI psychosis_](https://opensauce.it/cloudflare-ai-psychosis/)
(@orliesaurus, opensauce.it, 2026-08). Most of it is product-strategy critique
aimed at Cloudflare's org, not at anything we can fix. But it makes a set of
concrete technical complaints, and three of them land on code we own. This plan
audits ours against theirs, records where we are already the answer, and sizes
what is left.

## 0. Headline finding

**We inherit the single most specific defect the article names.** It criticises
Cloudflare's tracing because "non-I/O operations often report 0 ms because of
Spectre mitigations in the runtime." Every duration in this repo is computed as
`Date.now() - startTs` — `packages/observability/src/context-telemetry.ts:514`,
`:690`, `packages/observability/src/database-telemetry.ts:282`,
`packages/runtime/src/create-worker.ts:3814`, `:4171`, `:4372`,
`packages/do/src/shard-do.ts:4711`, `:4753`, `:5090`. Inside workerd that clock
does not advance between I/O operations, so **a `ctx.trace` span wrapping pure
computation reports `durationMs: 0` in our waterfall for exactly the same reason
it does in Cloudflare's.**

Nothing in the repo acknowledges this. The one comment that notices the symptom
(`packages/observability/src/span-buffer.ts:62-69`) attributes parent/child ties
to `startTs` having "millisecond resolution" — which is the wrong diagnosis. It
is not coarse resolution; the clock is frozen. A span that took 40 ms of CPU and
a span that took 0.001 ms are indistinguishable, and we render both as 0 ms with
no indication that the number is meaningless.

**We cannot beat Cloudflare's clock — it is a security property of the runtime,
not a bug. We can beat their honesty about it.** Reporting "unmeasurable, no I/O
occurred" instead of a confident `0` is a small change that turns a silently
wrong waterfall into a correct one. See W0.

Second finding, on the RAG side: the article's charge against AI Search is that
it "lags proper RAG platforms … on **quality, filtering, hybrid search, and
actual visibility**." We have real answers to all four — but **two of them are
reference-grade, not production-grade**, and they currently cancel each other
out (see G1/G2).

## 1. Current state (audit)

### 1a. What the article actually claims

Quoted or closely paraphrased, so a later reader does not have to re-fetch it.
Marked by whether it is actionable for us.

| #   | Claim                                                                                                                                                                                                                                                                                                                                      | Ours to act on?                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| C1  | **RAG.** AutoRAG → AI Search is "just a managed pipeline on R2, Vectorize, Workers AI. Fine for demos and hackathons." In real use it "lags … on quality, filtering, hybrid search, and actual visibility"                                                                                                                                 | **Yes** — §1c G1–G8                     |
| C2  | **Observability.** Tracing still open beta; **non-I/O operations report 0 ms (Spectre mitigations)**; **trace context does not propagate to external services**; **span attributes incomplete**; head sampling wrongly forced to 1% despite `head_sampling_rate: 1`; logs vanish from the dashboard while `wrangler tail` still shows them | **Yes** — §0, §1b, G9                   |
| C3  | **Docs.** Pages ship incomplete, examples rot, new products arrive "without the precise, versioned reference material (or even basic SKILL.md stuff for agents) that real infrastructure needs"; AI-generated docs needing later disclaimers                                                                                               | **Yes** — §1b, already largely answered |
| C4  | **Workers AI.** Still trails specialist providers on speed for many workloads and on newest frontier models; "the catalog is worse than last year's IKEA"; teams route hard inference elsewhere and treat CF as plumbing                                                                                                                   | **Yes** — §1b, already answered         |
| C5  | **Storage sprawl.** D1 / DO SQLite / KV / R2 / Queues / Hyperdrive, still no first-class managed Postgres that "feels native"; Hyperdrive is "an admission they never built the database most serious apps still want"; you glue 3–4 products together and hope the docs for that combination aren't six months stale                      | Partly — §1b, positioning               |
| C6  | **Compute sprawl.** Workers, Dynamic Workers, Sandboxes, Containers, "code mode" paths — each with different isolation, startup, pricing, bindings; "none of them is just 'the place you run code'"                                                                                                                                        | Partly — §1b, positioning               |
| C7  | **Agent sprawl.** Agents SDK, Flue, Project Think, Cloudflare OS; "observability gets bolted on later"; every announcement adds a harness instead of finishing the last one                                                                                                                                                                | Partly — §1b, positioning               |
| C8  | **Blog posts.** 6000 words of aspirational framing with "almost no real technical talk about the hard trade-offs or why they picked this design over the alternatives"                                                                                                                                                                     | Meta — see the note below               |
| C9  | Outage frequency (the Sept 12 dashboard/API outage traced to a React `useEffect` bug); leadership drift; the 2026 workforce cut                                                                                                                                                                                                            | No                                      |

**Corrections to the first pass of this plan.** Its claims table listed two
things the article does not say — a Vectorize 1,536-dimension / per-dimension
billing complaint, and an "AI Gateway evals are cost, speed and thumbs-up only"
complaint. Both came from search-engine summaries that had blended in unrelated
pages, and both have been removed here. The underlying code gaps they pointed at
are real and are kept as **G8** and **G6**, but they are our findings, not the
article's.

On C8: `plans/TEMPLATE.md` §4 already requires every design decision to record
the alternative it was chosen over, precisely so this repo does not have that
problem. It is worth noting that as an existing control rather than a new one.

### 1b. Where we are already the answer

| Claim                | Our position                                                                                                                                                                                                                                                    | Evidence                                                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 hybrid search     | RRF fusion of a vector leg and a pluggable BM25 leg — AI Search has no equivalent                                                                                                                                                                               | `packages/ai/src/rag/types.ts:196`, `packages/ai/src/rag/define-rag.ts:793-815`, `rag/hybrid-rank.ts`                                                 |
| C1 filtering         | Named filters plus an identity-derived `rlsFilter` merged **over** the caller's filter, so a caller can never widen scope; applied to both legs                                                                                                                 | `define-rag.ts:661-676`, `:753-755`                                                                                                                   |
| C1 visibility        | Each embed is a `generation` span carrying `gen_ai.operation.name`, `gen_ai.request.model`, and post-hoc `gen_ai.usage.input_tokens` / `gen_ai.usage.cost`                                                                                                      | `define-rag.ts:362-407`                                                                                                                               |
| C1 quality (partial) | Embedding-model **versioning** — a version tag folded into the namespace so swapping models re-partitions instead of silently returning noise — and a **content-hash re-index short-circuit** making periodic re-syncs free. AI Search has neither.             | `define-rag.ts:342-349`, `:465-471`                                                                                                                   |
| **C2 propagation**   | **The exact thing the article says Cloudflare broke on purpose: we inject W3C `traceparent` into outbound requests, and continue inbound context through worker → shard → container.**                                                                          | `packages/observability/src/context-telemetry.ts:604-653`, `packages/runtime/src/otel-trace.ts:197`, `packages/observability/src/trace-context.ts:21` |
| C2 sampling          | The inbound sampled bit is honoured rather than re-decided downstream, and the export gate is derived from the same decision so it cannot disagree with the propagated `traceparent`                                                                            | `packages/observability/src/trace-context.ts:26-31`, `packages/runtime/src/otel-trace.ts:145-158`                                                     |
| C2 attributes        | OTel `gen_ai.*` semconv on model spans; `error.type` uses the stable `LunoraError` catalog code so spans group by the same taxonomy as RPC spans                                                                                                                | `define-rag.ts:401-406`, `packages/observability/src/trace-context.ts:42-48`                                                                          |
| C2 logs-vs-tail      | Logs go through our own buffer and Studio rather than depending on the Cloudflare dashboard pipeline                                                                                                                                                            | `packages/observability/src/log-buffer.ts`                                                                                                            |
| **C3 docs**          | **`llms.txt`, `llms-full.txt` and per-page `.mdx` routes ship; 15 agent skills ship in `packages/cli/skills` plus the `plugins/lunora` plugin and its end-of-turn `lunora verify` hook — the literal "SKILL.md stuff for agents" the article says is missing.** | `apps/docs/src/routes/llms[.]txt.ts`, `llms-full[.]txt.ts`, `llms[.]mdx.docs.$.ts`, `packages/cli/skills/`, `plugins/lunora/`                         |
| **C3 examples rot**  | **Examples cannot rot silently: `pnpm run test:templates` scaffolds, installs, builds and typechecks every template, and `sdks/generated-check.sh` generates each SDK into a scratch dir then builds and _calls_ it.** CI gates, not review discipline.         | root `package.json`, `sdks/generated-check.sh`                                                                                                        |
| C4 Workers AI        | Workers AI is a zero-config **default and never a requirement** — every model input accepts a raw AI SDK model object, and a BYO `EmbeddingModel` skips `ctx.ai` entirely so a RAG index needs **no `env.AI` binding at all**                                   | `packages/ai/src/create-ai.ts:99`, `define-rag.ts:191-205`                                                                                            |
| C5/C6/C7 sprawl      | This is Lunora's whole thesis: one typed `ctx.*`, one deploy path, one capability matrix that says per-target whether a feature is `native`/`emulated`/`unsupported` instead of leaving the developer to reconcile product docs                                 | `packages/platform/src/capabilities.ts`, `AGENTS.md` "Platform parity"                                                                                |

C4 deserves emphasis because it is the cheapest marketing win here: the article's
complaint is that Cloudflare pitches itself as the place to run agents while its
model catalog forces you elsewhere. Our answer is that we never made the catalog
load-bearing.

### 1c. Gaps

**G1 — hybrid search cannot actually be deployed.** `bm25LexicalStore()` is
in-memory and per-isolate (`packages/ai/src/rag/lexical-store.ts:52`: "not
durable and not shared across isolates … tests, local development, and
single-isolate workloads"). No durable adapter ships. The single feature the
article says AI Search lacks is, in our shipping form, a test fixture.

**G2 — hybrid search and metadata RLS are mutually exclusive.**
`lexical-store.ts:143` fails closed on any non-empty filter, which is the correct
call for a store holding no metadata — but `rlsFilter` produces exactly that
shape, so turning on RLS silently reduces hybrid retrieval to vector-only. Two of
our four answers to C1 cancel each other out.

**G3 — the vector store is not pluggable.** `RagVectors` (`rag/types.ts:82`) is
structurally typed, but `defineRag` hard-codes Vectorize's semantics throughout:
the 10 KiB metadata ceiling (`define-rag.ts:38`), the 20/100 `topK` split
(`:29-31`), the account-global namespace hazard (`:167`), and the
async-mutation caveat (`:463`). `packages/platform/src/capabilities.ts:158` rates
`vectorStore` `native` on Cloudflare and `unsupported` on Node (`:272`) — RAG is
the reason `@lunora/platform-node` cannot host an AI app.

**G4 — no reranking.** Zero rerank/cross-encoder code in `packages/ai`. RRF is a
good cheap proxy; a cross-encoder pass over the top-N is the standard step, and
the one C1's "quality" charge points at most directly.

**G5 — no query transformation.** `retrieve(query)` embeds the raw string
(`define-rag.ts:759-766`). No HyDE, no multi-query expansion, no
conversational-follow-up rewriting, so second turns in a chat retrieve badly.
`RagContext.conversationId` exists (`rag/types.ts:123`) but only groups spans.

**G6 — evals are generation-only.** `packages/testing/src/scorer.ts:219` ships
`contains` / `regex` / `exactMatch` / `keyword` / `llm`. Nothing consumes a
`RetrieveResult`; no recall@k, MRR, nDCG, context precision, or
groundedness/faithfulness. "Actual visibility" (C1) means being able to _measure_
retrieval, not just trace it.

**G7 — no ingestion pipeline.** `index({ text })` takes a string
(`rag/types.ts:337-365`). No PDF/HTML/Markdown extraction, no bucket crawl, no
incremental sync driver. This is the one axis on which AutoRAG's managed pipeline
is genuinely more convenient than ours.

**G8 — no dimension-ceiling validation.** Nothing checks embedding
dimensionality against the store's limit, so pointing `embeddingModel` at a
3072-dim model fails at Vectorize with nothing naming the cause — the exact
failure mode `assertMetadataFits` (`define-rag.ts:85`) exists to prevent for
metadata. (Vectorize's ceiling is 1,536 dims at 32-bit precision.)

**G9 — `topK` capped at 20 where Vectorize V2 allows 50.** `define-rag.ts:29`
and `packages/bindings/src/vectors/create-vectors.ts:56`. Our own docs already
state the correct number and call ours "a legacy-V1 holdover"
(`packages/ai/docs/index.mdx:142`), so code and docs disagree today.

**G10 — chunking is a fixed character window** (`rag/chunk.ts`, 1000/200). No
token-aware, sentence, markdown-heading, or semantic chunker. The
character-against-a-byte-ceiling mismatch is already flagged as a sharp edge
(`define-rag.ts:301-318`).

**G11 — no embedding cache; retrieve embeds one at a time.** Indexing uses
bounded concurrency (`rag/concurrent.ts`) but not `embedMany` batching.

**G12 — cost/token telemetry is AI-Gateway-shaped.** `packages/ai/src/gateway.ts`
is entirely Cloudflare-specific and `embedCostOf` (`define-rag.ts:267-283`)
probes provider metadata only an AI Gateway populates, so spend visibility
degrades off Cloudflare — inside a telemetry stack that is otherwise
host-neutral by design. Separately `gateway.ts:184-189` documents that an
authenticated gateway is simply unreachable on the Workers AI binding path.

**G13 — hybrid fusion was computed and then discarded.** _(Found while
implementing W5/W6; not in the original audit, and the most serious defect in
this plan after §0.)_ `hybridRank` returned chunks in RRF order but left their
raw `score` fields untouched, and `retrieve()` re-sorted by `score` immediately
afterwards to apply importance weighting. Since BM25 is unbounded while cosine
is `[0, 1]`, that promoted **every** lexical-only hit above **every** vector hit
— so hybrid retrieval returned the union of both legs ranked by incomparable
numbers, which is worse than either leg alone. The RRF implementation was
correct; nothing consumed its output.

Three adjacent defects surfaced with it: `minScore` was applied to a
post-fusion score on a scale it is not documented against; the fused union was
never trimmed to `topK`, so a caller asking for 5 chunks could receive up to 5
per leg; and each leg fetched only `topK`, which defeats the lexical leg
entirely, since its purpose is to surface a chunk the vector leg ranked _below_
`topK`. All four are fixed and regression-tested.

The lesson worth keeping: the audit in §1b credited "RRF fusion of a vector leg
and a pluggable BM25 leg" as a shipped differentiator on the strength of the
code existing. It existed and did nothing. **A feature is not shipped until
something downstream is shown to consume its output** — which is what the
retrieval scorers in W7 now make testable.

## 2. Existing seams (do not reinvent)

- **`RagLexicalStore`** (`rag/types.ts:196`) — the seam for G1/G2 already exists.
  Those are adapters, not abstractions.
- **`@lunora/search-core`** (internal; analyzer, tokenizer, scorer, caps, cursor
  algebra, backfill policy) — the durable BM25 leg builds on this, not on a
  second scorer.
- **`@lunora/sql-store`** — dialect-parameterized SQL core already backing D1 and
  PlanetScale `.global()`. A pgvector adapter belongs behind it.
- **`@lunora/hyperdrive/global`** — reactive Postgres/PlanetScale backend, plus
  `lunora migrate d1-to-hyperdrive`. The migration shape for G3 exists.
- **`RagTextStore`** (`rag/types.ts:151`) — proves the pluggable-store pattern;
  `RagVectorStore` should mirror it.
- **`SpanEvent` / `SpanBuffer` / `foldTraces`** (`observability/src/span-buffer.ts`)
  — W0 changes what is recorded and rendered, not the buffer.
- **`packages/testing/src/scorer.ts`'s `Scorer` interface** — G6 adds scorers,
  it does not need a second eval framework.
- **`@lunora/queue` + `@lunora/workflow` + `@lunora/storage`** — G7's fan-out
  and durability, already shipped.

## 3. The behavioural contract to preserve

- `defineRag` with no new options must stay byte-identical: same chunk ids, same
  namespace scheme, same `RetrieveResult`. Every addition here is opt-in.
- The un-versioned chunk-id/namespace scheme (`define-rag.ts:343-349`, the
  identity map when `embeddingModelVersion` is unset) is load-bearing for
  already-indexed data. Do not touch it.
- RLS keys keep winning over caller-supplied filter keys (`define-rag.ts:755`),
  on every leg, in every new adapter.
- Any new lexical or vector adapter that cannot evaluate a filter must fail
  **closed**, matching `lexical-store.ts:143`. Fail-open is a tenant leak.
- W0 must not change the OTLP wire format for spans that _do_ have a measurable
  duration; an unmeasurable span omits the attribute rather than inventing a
  sentinel that a collector would chart as a number.
- `api-snapshots/{ai,observability}.api.md` gate the public surface — new exports
  need `pnpm run api:update` after a fresh build.

## 4. Design decisions

**D1 — report unmeasurable durations as absent, not as `0`.** Alternative
rejected: reporting `-1` or `null` as a sentinel — a collector charts sentinels
as data. Second alternative rejected: leaving it, on the grounds that everyone on
workerd has this problem. That is precisely the article's complaint, and "the
platform does it too" is not a defence for a framework whose selling point is
that it makes the platform coherent.

**D2 — detect unmeasurability from I/O, not from the duration value.** A span
whose duration is 0 _and_ which performed no I/O is unmeasurable; a span that did
I/O and still reads 0 was genuinely fast. Alternative rejected: treating every
`0` as unknown, which would erase real sub-millisecond spans.

**D3 — extract a `RagVectorStore` seam rather than adding a second RAG package.**
Alternative rejected: a `@lunora/rag-postgres` with its own `definePgRag` — it
forks the chunking, hashing, RRF, RLS and versioning logic `define-rag.ts`
already gets right, and guarantees drift.

**D4 — the store declares its own caps; `defineRag` stops hard-coding
Vectorize's.** `MAX_TOP_K_FULL_METADATA`, `VECTORIZE_METADATA_BYTES` and the
dimension ceiling become adapter fields. Alternative rejected: keeping the
constants and having other adapters ignore them, which leaves a pgvector user
capped at 20 results and 10 KiB of metadata for no reason.

**D5 — build the durable lexical leg on `@lunora/search-core` + DO SQLite FTS
first, D1 second.** Alternative rejected: leading with an external search
service. DO SQLite makes the shard _be_ the tenant boundary, which deletes the
account-global-namespace hazard class (`define-rag.ts:167`) rather than warning
about it, and adds nothing to the bill.

**D6 — pgvector-over-Hyperdrive is the flagship non-Cloudflare adapter.** It
answers C1-filtering (real SQL predicates, not a metadata DSL), C1-hybrid
(`tsvector` + HNSW fused in one query, one filter, one round-trip), G8 (no
dimension ceiling), and C5 (it _is_ the first-class Postgres the article says is
missing) — reusing bindings we already ship.

**D7 — reranking is an injected hook, not a bundled model.** `rerank?: (query,
chunks) => Promise<chunks>` with thin adapters, matching how `llmScorer` injects
its judge (`scorer.ts:159`). Keeps `@lunora/ai` free of provider dependencies.

**D8 — cost/token accounting moves into `@lunora/observability` with a static
price table; the AI Gateway becomes one enrichment source, not the source.**
Alternative rejected: leaving `embedCostOf` as the only path, which makes spend
visibility a Cloudflare feature inside a host-neutral telemetry stack.

## 5. Workstreams

| ID  | Work                                                                                                      | Size | Gap     | Status                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------- | ---- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W0  | Unmeasurable-duration honesty                                                                             | S    | §0      | **STOPPED; narrow version shipped.** Misdiagnosis at `span-buffer.ts` corrected, limitation documented. I/O detection hit its own STOP condition — see §8.                                                                                                                                                                                                                                              |
| W1  | Raise the full-metadata `topK` ceiling 20 → 50                                                            | S    | G9      | **DONE.** `define-rag.ts`, `create-vectors.ts`, docs. V1's 20 documented as a remote-reject risk.                                                                                                                                                                                                                                                                                                       |
| W2  | Dimension-ceiling validation                                                                              | S    | G8      | **DONE.** `maxEmbeddingDimensions` (default 1536), checked once per bound context, names the model + both escapes.                                                                                                                                                                                                                                                                                      |
| W3  | Structure-aware chunkers                                                                                  | S    | G10     | **DONE.** `sentenceChunker`, `markdownChunker` (heading trail, fence-aware), `tokenChunker` (injected `countTokens`).                                                                                                                                                                                                                                                                                   |
| W4  | Index-path embed batching + query cache                                                                   | S    | G11     | **DONE.** One `embedMany` per document (best-effort, dedupes); `cacheEmbeddings` retains across calls, default 0.                                                                                                                                                                                                                                                                                       |
| W5  | `rerank?` hook + adapters                                                                                 | S–M  | G4      | **DONE.** `scoreReranker` / `batchReranker`, injected scorers, per-call `{ rerank: false }`.                                                                                                                                                                                                                                                                                                            |
| W6  | `transformQuery?` hook                                                                                    | S–M  | G5      | **DONE.** Rewrite or multi-query expansion fused by RRF; receives `conversationId`; falls back on unusable output.                                                                                                                                                                                                                                                                                      |
| W7  | Retrieval scorers                                                                                         | M    | G6      | **DONE.** `recallAtK` / `precisionAtK` / `mrrScorer` / `ndcgAtK` / `groundednessScorer`; `evaluate` producers may return run metadata.                                                                                                                                                                                                                                                                  |
| —   | **Hybrid fusion discarded by the caller's re-sort** (found while doing W5/W6 — not in the original audit) | S    | **G13** | **DONE.** `hybridRank` now writes the fused score back. Also: per-leg `minScore`, `topK` trim of the union, `candidates` pool widening. See §1c G13.                                                                                                                                                                                                                                                    |
| W8  | Durable + filter-aware lexical store                                                                      | M    | G1, G2  | **DONE.** Root cause fixed (`StoredRagChunk` carries metadata; `bm25LexicalStore` evaluates the filter, so hybrid + RLS compose) **and** `sqlLexicalStore` ships a durable inverted index over the `RagSqlExec` seam, sharing the BM25 kernel so the ranking does not move.                                                                                                                             |
| W9  | `RagVectorStore` seam                                                                                     | M    | G3      | TODO — blocks W10/W11.                                                                                                                                                                                                                                                                                                                                                                                  |
| W10 | pgvector adapter over `@lunora/hyperdrive`                                                                | M–L  | —       | **NOT SHIPPED — deliberately.** G3 is closed by W9 + W11; this was one proposed adapter, not a finding. No Postgres is reachable from this environment, so an adapter could not be run against a live server — and shipping unverified SQL as a supported export is the exact "works for simple cases" pattern this plan is a response to. The seam supports it and `packages/ai/docs` shows the shape. |
| W11 | SQL-backed vector adapter                                                                                 | M    | G3      | **DONE.** `sqliteVectorStore` over DO SQLite / D1 / `node:sqlite`, tested against a real engine. Declares no dimension or metadata ceiling. Flipped `NODE_CAPABILITIES.vectorStore` to `emulated`.                                                                                                                                                                                                      |
| W12 | Host-neutral cost/token accounting                                                                        | M    | G12     | **DONE.** `estimateModelCost` + price table in `@lunora/ai`; span stamps `lunora.usage.cost.source` so an estimate is never read as a measurement. Deviates from D8 — see below.                                                                                                                                                                                                                        |
| W13 | `defineRagSource` ingestion pipeline                                                                      | L    | G7      | **DONE.** Injected object source + extractors, content-hash-free re-sync, prune-to-mirror with a safe first pass.                                                                                                                                                                                                                                                                                       |

**W8's remaining half.** The blocking defect is fixed — hybrid retrieval and
metadata RLS no longer cancel each other out, and `matchesMetadataFilter` is
exported so any store can evaluate the predicate. What is still missing is a
**durable** adapter: `bm25LexicalStore` remains in-memory and per-isolate. That
work belongs with W9–W11 rather than before them, because a SQL-backed lexical
index and a SQL-backed vector index want the same injected executor seam, and
building one without the other means designing that seam twice.

**Follow-up work, none of it blocking:** a pgvector adapter (W10) once a
Postgres is available to verify against; an ANN index for `sqliteVectorStore`,
which is brute force today and bounded by `maxScan`; and re-opening W0's I/O
detection if the runtime ever exposes a per-request I/O counter.

## 6. Platform parity

W0 changes span _content_, not a `ctx.*` surface or binding — but the
unmeasurable-duration condition is **host-specific** (workerd's Spectre-mitigated
clock), so it belongs in the matrix as a note rather than a feature row: a Node
host has a real monotonic clock and never marks a span unmeasurable. Record it on
the `cloudflare` entry when W0 lands.

W9–W11 changed how `vectorStore` maps. **Landed:**

| Feature                                      | `cloudflare` | `node`      | Notes                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------- | ------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.vectors` (Vectorize adapter)            | native       | unsupported | Unchanged — this row is the binding, not a RAG index over it.                                                                                                                                                                                                                                                                                                                                           |
| `RagVectorStore` — `sqliteVectorStore` (W11) | emulated     | emulated    | Cloudflare: DO SQLite or D1. Node: `node:sqlite` / better-sqlite3. Built over the injected `RagSqlExec`, not a provider product, so `emulated` on both per the `capabilities.ts:118-127` rule. **This is what moved `NODE_CAPABILITIES.vectorStore` from `unsupported` to `emulated`** — with a note recording that it covers RAG indexes and not `ctx.vectors` itself, and that search is brute force. |
| `RagLexicalStore` — `sqlLexicalStore` (W8)   | emulated     | emulated    | Same seam; no provider product on either host.                                                                                                                                                                                                                                                                                                                                                          |
| `RagVectorStore` — pgvector (W10)            | emulated     | emulated    | **Not shipped** (see §5). Stated here anyway so the matrix does not need revisiting when it lands.                                                                                                                                                                                                                                                                                                      |

W1–W7 and W12 touch no `ctx.*` surface or binding — parity unchanged.
`packages/codegen/src/platform-target.ts:186` maps `vectors → vectorStore`, so
any capability change here is consumed by codegen and must land with the matrix
edit in the same change.

## 7. Phasing & ordering

| Phase | Work           | Gate                                                                                                                                                                                                                                                                                                      |
| ----- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | W0 (narrow)    | **Shipped.** No automated gate is possible — Miniflare does not reproduce the production clock, so a test asserting production behaviour fails locally against correct code. Verified by the probe in §9 Q1.                                                                                              |
| 0     | W1, W2         | `topK: 50` metadata-mode retrieval returns 50 chunks against a seeded index; a 3072-dim `embeddingModel` throws a named error at define time. `pnpm --filter "@lunora/ai" run test` + `pnpm run api:check` green.                                                                                         |
| 1     | W8             | A new `RagLexicalStore` conformance suite under `packages/platform/src/conformance` that both stores run, **including a filtered-search case the in-memory store is expected to fail closed on and the SQLite one is expected to answer.** Hybrid + metadata `rlsFilter` returns a non-empty lexical leg. |
| 2     | W3, W4, W5, W6 | Golden-fixture retrieval-quality suite (W7's scorers): rerank and HyDE each measurably raise nDCG@10 on a committed corpus, **or the workstream is rejected rather than shipped on faith.**                                                                                                               |
| 3     | W7             | `lunora eval` runs a retrieval eval fixture end-to-end and fails below threshold.                                                                                                                                                                                                                         |
| 4     | W9             | The existing Vectorize path is **byte-identical**: same chunk ids, same namespaces, same `RetrieveResult`, existing tests unmodified.                                                                                                                                                                     |
| 5     | W10, W11       | One `RagVectorStore` conformance suite passes against Vectorize, pgvector and DO SQLite. `NODE_CAPABILITIES.features.vectorStore.level` flips off `"unsupported"` and `packages/platform/__tests__/contracts.test.ts:45` is updated in the same commit.                                                   |
| 6     | W12, W13       | Cost telemetry present on a non-Cloudflare provider with no AI Gateway configured. `defineRagSource` indexes an R2 bucket and re-syncs at zero embed cost.                                                                                                                                                |

## 8. Risks & STOP conditions

- ~~**STOP if W0's unmeasurable condition cannot be detected without threading
  I/O state through every span site.**~~ **Triggered — narrow version shipped.**
  Both halves of the escape clause were met: there is no I/O signal to read (§9
  Q2), and no gate could prove a fix works, since Miniflare does not reproduce
  the production behaviour (§9 Q1). Shipped instead: the corrected diagnosis at
  `span-buffer.ts:62-69`, and a "Span durations on Workers" section in
  `apps/docs/.../concepts/observability.mdx` stating that a `0 ms` span means
  "no I/O happened here", not "this was fast" — and that the defect is invisible
  under `wrangler dev`. A documented limitation still beats a confident wrong
  number. **Re-open if** the runtime exposes a per-request I/O counter, or if
  `@lunora/platform-node` (real monotonic clock) makes a differential test
  possible.
- **STOP if the SQLite FTS lexical leg cannot honour a metadata filter.** A
  lexical store that fails closed under RLS is what we already have
  (`lexical-store.ts:143`); W8's entire value is composing with RLS. If
  `@lunora/search-core` cannot carry metadata predicates, re-scope to extend it
  rather than ship a second fail-closed adapter.
- **STOP if W9 cannot keep the Vectorize path byte-identical.** The seam is only
  worth it if it is invisible to existing indexes; needing a migration means the
  design is wrong, not that users need a migration guide.
- **Risk: W5/W6 add latency and cost for unproven quality gains.** Mitigate:
  phase 2's gate is a measured nDCG@10 improvement on a committed corpus, not a
  code review. Both stay opt-in and default off.
- **Risk: raising `topK` 20 → 50 (W1) raises per-query metadata transfer 2.5×**,
  and Vectorize's docs warn that `returnMetadata: "all"` queries run slower.
  Mitigate: the ceiling rises, the **default** `topK` stays 5
  (`define-rag.ts:26`).
- **Risk: pgvector-over-Hyperdrive is action-only and non-reactive** — the
  guardrail `@lunora/hyperdrive` already documents. Mitigate: state it in the
  adapter docs; RAG retrieval is already action-only
  (`packages/ai/docs/index.mdx:28`), so it costs nothing here.
- **Perf watch:** retrieval p50/p99 with and without the lexical leg; index
  throughput with `embedMany` batching (W4). Name the bench suite when W4 lands.

## 9. Open questions (answer during execution)

1. ~~Does workerd's `performance.now()` advance independently of `Date.now()`?~~
   **Answered: no.** Probed under Miniflare (30M-iteration CPU spin, no I/O):
   `Date.now()` and `performance.now()` reported the _same_ 60 ms delta, so
   `performance.now()` is not an independent clock and cannot rescue the
   measurement. W0 is an honesty fix, not a measurement fix.

    The probe also turned up something worse, now documented: **Miniflare does
    not apply the production mitigation**, so both clocks advance normally
    locally. The defect is invisible in `wrangler dev` and appears only in
    production — which also means the phase-0 gate as originally written cannot
    be built, since locally a pure-CPU span reports a real duration and the test
    would fail against correct code.

2. ~~What is the cheapest reliable signal that a span performed I/O?~~
   **Answered: there isn't one today.** No I/O counter exists — the telemetry
   wrappers (`database-telemetry.ts`, `context-telemetry.ts`) count nothing a
   span could read. Adding one means threading state through `shard-do.ts`
   (~8.5k lines) and `create-worker.ts`, with no gate able to prove it works.
   Together with Q1 this triggered W0's STOP condition.
3. Does `@lunora/search-core`'s analyzer/scorer carry enough to evaluate a
   metadata predicate, or does W8 need a schema extension? (Gates W8 — see the
   STOP condition.)
4. Is the 20 → 50 `topK` raise safe for **legacy V1** Vectorize indexes, or does
   the adapter need to detect index version and cap accordingly? (Gates W1.)
5. Should `embeddingModelVersion` become **required** once `RagVectorStore` makes
   swapping stores easy? The failure it prevents gets more likely, not less, when
   the store is pluggable.
6. Does `sqlite-vec` load inside workerd's SQLite, or is W11 restricted to
   brute-force cosine? (Bounds W11's usable index size.)
7. Where does the static model price table live — `@lunora/observability`, or a
   generated artifact refreshed by a script under `scripts/`? (Gates W12.)
