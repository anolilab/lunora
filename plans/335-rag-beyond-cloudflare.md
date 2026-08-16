# Plan 335 — RAG & AI: close the gaps the "Cloudflare AI psychosis" critique names, and break the Vectorize hard-coupling

**Baseline:** `cadabf5` (2026-08-16)
**Status:** TODO

Prompted by [_Cloudflare's AI psychosis_](https://opensauce.it/cloudflare-ai-psychosis/)
(opensauce.it, 2026-08). The article is a product-strategy critique, not a bug
report, but four of its concrete complaints land on surfaces `@lunora/ai` owns.
This plan audits our code against them, records where we are already ahead, and
sizes the gaps that remain.

> **Source caveat.** The article itself is unreachable from this repo's egress
> proxy; its claims below were reconstructed from search-engine extracts and
> cross-checked against Cloudflare's own docs where they are load-bearing (the
> Vectorize `topK` and dimension limits were verified; the observability claims
> were not). Re-read the original before treating any un-verified line as fact.

## 0. Headline finding

**The critique's four technical complaints are: weak hybrid search, weak
filtering, weak retrieval visibility, and a Vectorize dimension ceiling.
`@lunora/ai/rag` already answers the first three better than Cloudflare's AI
Search does — but two of those answers are reference-grade, not
production-grade, and the fourth is unanswered because our RAG is
hard-coupled to Vectorize.**

Specifically:

- **Hybrid search exists but cannot be deployed.** `bm25LexicalStore()` is
  in-memory and per-isolate (`packages/ai/src/rag/lexical-store.ts:52`). The one
  differentiator the article says AI Search lacks is, in our shipping form, a
  test fixture.
- **Filtering exists but the two features fight each other.** With
  metadata-based `rlsFilter` set, the lexical leg **fails closed and returns
  nothing** (`packages/ai/src/rag/lexical-store.ts:143`). So today you get
  hybrid search _or_ metadata RLS, not both.
- **We ship a `topK` cap of 20 where Vectorize allows 50** — and our own docs
  already say so (`packages/ai/docs/index.mdx:142`, "Ours is a legacy-V1
  holdover"). Two constants, 2.5× retrieval depth.
- **Vectorize's 1,536-dimension ceiling is unhandled**, and it silently rules
  out most current embedding models.

The single highest-leverage move is not a new Cloudflare product — it is a
`RagVectorStore` seam plus a durable lexical store built on
`@lunora/search-core`, which the repo already owns. Both reduce Cloudflare
surface rather than adding it.

## 1. Current state (audit)

### 1a. What the article claims

| #   | Claim                                                                                                                                                                   | Verified?                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| C1  | AI Search (ex-AutoRAG) is a managed R2 + Vectorize + Workers AI pipeline that "lags proper RAG platforms … on quality, filtering, hybrid search, and actual visibility" | Not independently verified                                                   |
| C2  | Workers AI trails specialist providers on latency and frontier-model availability; teams route hard inference elsewhere                                                 | Not independently verified                                                   |
| C3  | Vectorize is billed per dimension and capped at 1,536 dimensions                                                                                                        | **Verified** — Cloudflare docs confirm the 1,536 ceiling at 32-bit precision |
| C4  | Storage sprawl (D1 / DO SQLite / KV / R2 / Queues / Hyperdrive) with no first-class managed Postgres; apps glue 3–4 products together against stale docs                | Editorial                                                                    |
| C5  | Workers observability is partial: tracing in open beta, non-I/O spans report 0 ms (Spectre mitigations), trace context does not propagate to external services          | Not independently verified                                                   |
| C6  | AI Gateway evals are "cost, speed, and human thumbs-up only"                                                                                                            | Not independently verified                                                   |

Also verified while checking C3: **Vectorize V2 allows `topK` up to 100, and up
to 50 when `returnValues: true` or `returnMetadata: "all"`.** The 20 ceiling is
V1-only.

### 1b. Where we already answer it

| Claim          | Our answer                                                                                                                                                                              | Evidence                                                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 hybrid      | RRF fusion of a vector leg and a pluggable BM25 leg                                                                                                                                     | `packages/ai/src/rag/types.ts:196`, `packages/ai/src/rag/define-rag.ts:793-815`, `packages/ai/src/rag/hybrid-rank.ts`                                 |
| C1 filtering   | Named filters + identity-derived `rlsFilter` merged **over** the caller's filter so a caller can never widen scope, applied to both legs                                                | `define-rag.ts:661-676`, `define-rag.ts:753-755`                                                                                                      |
| C1 visibility  | Each embed is a `generation` span carrying `gen_ai.operation.name`, `gen_ai.request.model`, post-hoc `gen_ai.usage.input_tokens` and `gen_ai.usage.cost`                                | `define-rag.ts:362-407`                                                                                                                               |
| C2             | Every model input accepts a raw AI SDK model object, so Workers AI is a default and never a requirement; a BYO `EmbeddingModel` skips `ctx.ai` and needs **no `env.AI` binding at all** | `packages/ai/src/create-ai.ts:99`, `define-rag.ts:191-205`                                                                                            |
| C5 propagation | W3C `traceparent` is injected into outbound requests, and inbound context is continued through worker → shard → container                                                               | `packages/observability/src/context-telemetry.ts:604-653`, `packages/runtime/src/otel-trace.ts:197`, `packages/observability/src/trace-context.ts:21` |
| C6             | `lunora eval` + injectable scorers incl. LLM-as-judge                                                                                                                                   | `packages/cli/src/commands/eval/`, `packages/testing/src/scorer.ts:219`                                                                               |

Two capabilities we have that AI Search has no equivalent for, worth naming in
marketing: **embedding-model versioning** (`define-rag.ts:342-349` — folds a
version tag into the namespace so a model swap re-partitions instead of
silently returning noise) and the **content-hash re-index short-circuit**
(`define-rag.ts:465-471` — periodic re-syncs cost nothing).

### 1c. Gaps

**G1 — `topK` capped at 20 where Vectorize allows 50.**
`define-rag.ts:29` (`MAX_TOP_K_FULL_METADATA = 20`) and
`packages/bindings/src/vectors/create-vectors.ts:56`
(`MAX_TOP_K_WITH_VALUES = 20`). `packages/ai/docs/index.mdx:142` already
documents the correct number, so code and docs disagree today.

**G2 — no durable lexical store.** `lexical-store.ts:52` is explicit: "not
durable and not shared across isolates … intended for tests, local development,
and single-isolate workloads." No durable adapter ships. Compounding it,
`lexical-store.ts:143` fails closed on any non-empty filter, so hybrid + RLS is
currently mutually exclusive.

**G3 — the vector store is not pluggable.** `RagVectors` (`rag/types.ts:82`) is
structurally typed, but `defineRag` hard-codes Vectorize's semantics
throughout: the 10 KiB metadata ceiling (`define-rag.ts:38`), the 20/100 `topK`
split (`:29-31`), the account-global namespace warning (`:167`), and the
async-mutation caveat (`:463`). `packages/platform/src/capabilities.ts:158`
rates `vectorStore` `native` on Cloudflare and `unsupported` on Node (`:272`),
so RAG is the reason `@lunora/platform-node` cannot host an AI app.

**G4 — no reranking.** Zero occurrences of rerank/cross-encoder logic in
`packages/ai`. RRF fusion is a good cheap proxy, but a cross-encoder pass over
the top-50 is the standard quality step and the one the article's "quality"
complaint most directly points at.

**G5 — no query transformation.** `retrieve(query)` embeds the raw string
(`define-rag.ts:759-766`). No HyDE, no multi-query expansion, no
conversational-follow-up rewriting — so pronoun-laden second turns in a chat
retrieve badly. `RagContext.conversationId` already exists (`rag/types.ts:123`)
but is used only for span grouping.

**G6 — evals cover generation, not retrieval.** `packages/testing/src/scorer.ts`
ships `contains` / `regex` / `exactMatch` / `keyword` / `llm` scorers. There is
no recall@k, MRR, nDCG, context precision, or groundedness/faithfulness scorer,
and nothing that consumes a `RetrieveResult`. Against C6 we are ahead, but only
on the generation axis.

**G7 — no ingestion pipeline.** `index({ text })` takes a string
(`rag/types.ts:337-365`). No document extraction (PDF/HTML/Markdown), no
bucket-crawl, no incremental sync driver. This is the one place AutoRAG's
managed pipeline is genuinely more convenient than ours.

**G8 — chunking is a fixed character window.** `packages/ai/src/rag/chunk.ts`,
1000/200 defaults. No token-aware, sentence, markdown-heading, or semantic
chunker ships. The character-vs-byte mismatch is already documented as a sharp
edge (`define-rag.ts:301-318`).

**G9 — no embedding cache, and retrieve embeds one at a time.** Every
`retrieve()` is a fresh embed call. Indexing uses bounded concurrency
(`rag/concurrent.ts`) but not `embedMany` batching.

**G10 — cost/token telemetry is AI-Gateway-shaped.** `packages/ai/src/gateway.ts`
is entirely Cloudflare-specific, and `embedCostOf` (`define-rag.ts:267-283`)
probes provider metadata that only an AI Gateway populates. Off Cloudflare,
spend visibility degrades — even though `@lunora/observability` is host-neutral
by design. Separately, `gateway.ts:184-189` documents that an authenticated
gateway is simply unreachable on the Workers AI binding path.

**G11 — the 1,536-dimension ceiling is unhandled.** Nothing in `defineRag`
validates embedding dimensionality against the store's ceiling, so pointing
`embeddingModel` at `text-embedding-3-large` (3072), Gemini embedding (3072),
or Qwen3-Embedding (4096) fails at Vectorize with nothing naming the cause —
exactly the failure mode `assertMetadataFits` (`define-rag.ts:85`) exists to
prevent for metadata.

## 2. Existing seams (do not reinvent)

- **`RagLexicalStore`** (`rag/types.ts:196`) — the seam for G2 already exists.
  G2 is an adapter, not an abstraction.
- **`@lunora/search-core`** (internal, bundled into server/do/sql-store) —
  analyzer, tokenizer, scorer, caps, cursor algebra, backfill policy. The
  durable BM25 leg should be built on this, not on a second scorer.
- **`@lunora/sql-store`** — dialect-parameterized SQL core already backing D1
  and PlanetScale `.global()`. A pgvector adapter belongs behind it.
- **`@lunora/hyperdrive/global`** — reactive PlanetScale/Postgres backend, plus
  `lunora migrate d1-to-hyperdrive`. The migration shape for G3 already exists.
- **`RagTextStore`** (`rag/types.ts:151`) — proves the pluggable-store pattern
  works here; `RagVectorStore` should mirror its shape.
- **`ctx.trace` / `@lunora/observability`** — host-neutral. G10's fix is to move
  accounting into it, not to build a second telemetry path.
- **`@lunora/queue` + `@lunora/workflow` + `@lunora/storage`** — G7's fan-out
  and durability, already shipped.
- **`packages/testing/src/scorer.ts`'s `Scorer` interface** — G6 adds scorers to
  it, it does not need a second eval framework.

## 3. The behavioural contract to preserve

- `defineRag` with no new options must behave byte-identically: same chunk ids,
  same namespace scheme, same `RetrieveResult` shape. Every addition here is
  opt-in.
- The un-versioned chunk-id/namespace scheme (`define-rag.ts:343-349`, the
  identity map when `embeddingModelVersion` is unset) is load-bearing for
  already-indexed data. Do not touch it.
- RLS keys must keep winning over caller-supplied filter keys
  (`define-rag.ts:755`), on every leg, in every new store adapter.
- Any new lexical or vector adapter that cannot evaluate a filter must fail
  **closed**, matching `lexical-store.ts:143`. Fail-open is a tenant leak.
- `api-snapshots/ai.api.md` gates the public surface — every new export needs
  `pnpm run api:update` after a fresh build.

## 4. Design decisions

**D1 — extract a `RagVectorStore` seam rather than adding a second RAG package.**
Alternative rejected: a `@lunora/rag-postgres` package with its own
`definePgRag`. That forks the chunking, hashing, RRF, RLS, and versioning logic
that `define-rag.ts` already gets right, and guarantees drift. The seam mirrors
`RagTextStore`/`RagLexicalStore`, which is the pattern the file already
established.

**D2 — the store declares its own caps; `defineRag` stops hard-coding
Vectorize's.** `MAX_TOP_K_FULL_METADATA`, `VECTORIZE_METADATA_BYTES`, and the
dimension ceiling become fields on the store adapter. Alternative rejected:
keeping the constants and having non-Vectorize adapters ignore them — that
leaves a pgvector user capped at 20 results and 10 KiB of metadata for no
reason.

**D3 — build the durable lexical leg on `@lunora/search-core` + DO SQLite FTS
first, D1 second.** Alternative rejected: leading with an external search
service. DO SQLite makes the shard _be_ the tenant boundary, which deletes the
entire account-global-namespace hazard class (`define-rag.ts:167`) rather than
warning about it, and adds no product to the bill.

**D4 — pgvector-over-Hyperdrive is the flagship non-Cloudflare adapter.** It
answers C3 (no dimension ceiling), C1-filtering (real SQL predicates, not a
metadata DSL), C1-hybrid (`tsvector` + HNSW fused in one query, one filter, one
round-trip), and C4 (it _is_ the first-class Postgres the article says is
missing) — reusing bindings the repo already ships.

**D5 — reranking is an injected hook, not a bundled model.** `rerank?: (query,
chunks) => Promise<chunks>`, with thin adapters. Keeps `@lunora/ai` free of
provider dependencies, matching how `llmScorer` injects its judge
(`scorer.ts:159`).

**D6 — cost/token accounting moves to `@lunora/observability` with a static
price table; the AI Gateway becomes one enrichment source, not the source.**
Alternative rejected: leaving `embedCostOf` as the only path — it makes spend
visibility a Cloudflare feature in a host-neutral telemetry stack.

## 5. Workstreams

| ID  | Work                                                                                                                                                                                              | Size    | Gap        | Independent?   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------- | -------------- |
| W1  | Raise the full-metadata `topK` ceiling 20 → 50 in `define-rag.ts:29` and `create-vectors.ts:56`; correct `packages/ai/docs/index.mdx:142`                                                         | **S**   | G1         | yes            |
| W2  | Dimension-ceiling validation at define/index time, naming the ceiling and the escapes (Matryoshka `dimensions` truncation, or a non-Vectorize store)                                              | **S**   | G11        | yes            |
| W3  | Built-in chunkers: token-aware, sentence, markdown-heading                                                                                                                                        | **S**   | G8         | yes            |
| W4  | Query-embedding cache (content-hash keyed) + `embedMany` batching on the index path                                                                                                               | **S**   | G9         | yes            |
| W5  | `rerank?` hook + `workersAiReranker()` / BYO adapters                                                                                                                                             | **S–M** | G4         | yes            |
| W6  | `transformQuery?` hook + shipped HyDE and multi-query expansion strategies; wire `conversationId` into follow-up rewriting                                                                        | **S–M** | G5         | yes            |
| W7  | Retrieval scorers (recall@k, MRR, nDCG, context precision) + groundedness/faithfulness scorers + a `RetrieveResult`-shaped eval fixture                                                           | **M**   | G6         | yes            |
| W8  | **`sqliteLexicalStore()`** over `@lunora/search-core` + DO SQLite FTS — durable, metadata/filter-aware (so hybrid + RLS finally compose)                                                          | **M**   | G2         | yes            |
| W9  | **`RagVectorStore` seam** — extract the Vectorize adapter behind it, move caps onto the adapter (D2), keep `defineRag` byte-identical on the existing path                                        | **M**   | G3         | blocks W10/W11 |
| W10 | **pgvector adapter over `@lunora/hyperdrive`** — HNSW + `tsvector` hybrid in one query, no dimension ceiling                                                                                      | **M–L** | G3, C3, C4 | after W9       |
| W11 | DO-SQLite vector adapter (brute-force cosine; `sqlite-vec` if/when available) for small per-tenant indexes                                                                                        | **M**   | G3         | after W9       |
| W12 | Move model cost/token accounting into `@lunora/observability` with a static price table; demote AI Gateway to an enrichment source                                                                | **M**   | G10        | yes            |
| W13 | `defineRagSource({ bucket })` ingestion pipeline over `@lunora/storage` + `@lunora/queue` + `@lunora/workflow`, reusing the content-hash short-circuit; document extractors for PDF/HTML/Markdown | **L**   | G7         | after W9       |

**Suggested first cut (highest value / lowest risk): W1 + W2 + W8.** W1 and W2
are hours. W8 turns the hybrid-search claim from a reference fixture into a
production feature, fixes the hybrid-vs-RLS conflict, adds no Cloudflare
product, and needs no new abstraction — the seam already exists.

## 6. Platform parity

W9–W11 change how `vectorStore` maps, so the matrix moves:

| Feature                                     | `cloudflare` | `node`      | Notes                                                                                                                                                                                 |
| ------------------------------------------- | ------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.vectors` (Vectorize adapter)           | native       | unsupported | Unchanged. `capabilities.ts:158` / `:272` stay as they are.                                                                                                                           |
| `RagVectorStore` — pgvector adapter (W10)   | emulated     | emulated    | Lunora builds it over Hyperdrive/`@lunora/sql-store`, not a first-class provider product. Must be rated `emulated` on both, per the `capabilities.ts:118-127` rule.                   |
| `RagVectorStore` — DO-SQLite adapter (W11)  | emulated     | emulated    | Cloudflare: over DO SQLite. Node: over `@lunora/platform-node`'s better-sqlite3 shard state. **This is what flips `vectorStore` off `unsupported` for Node** (`capabilities.ts:272`). |
| `RagLexicalStore` — SQLite FTS adapter (W8) | emulated     | emulated    | Built on `@lunora/search-core`; no provider product on either host.                                                                                                                   |

W1–W7 and W12 touch no `ctx.*` surface or binding — parity unchanged.

`packages/codegen/src/platform-target.ts:186` maps `vectors → vectorStore`, so
any capability change here is consumed by codegen and must land with the matrix
edit in the same change.

## 7. Phasing & ordering

| Phase | Work           | Gate                                                                                                                                                                                                                                                                                                                                        |
| ----- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | W1, W2         | A `topK: 50` metadata-mode retrieval returns 50 chunks against a seeded index; a 3072-dim `embeddingModel` throws a named error at define time. `pnpm --filter "@lunora/ai" run test` + `pnpm run api:check` green.                                                                                                                         |
| 1     | W8             | `packages/platform/src/conformance` — a new `RagLexicalStore` conformance suite that both `bm25LexicalStore` and `sqliteLexicalStore` pass, **including a filtered-search case the in-memory store is expected to fail closed on and the SQLite one is expected to answer**. Hybrid + metadata `rlsFilter` returns a non-empty lexical leg. |
| 2     | W3, W4, W5, W6 | Golden-fixture retrieval-quality suite (W7's scorers): rerank and HyDE each measurably raise nDCG@10 on a committed fixture corpus, or the workstream is rejected rather than shipped on faith.                                                                                                                                             |
| 3     | W7             | `lunora eval` runs a retrieval eval fixture end-to-end and fails below threshold.                                                                                                                                                                                                                                                           |
| 4     | W9             | `defineRag`'s existing Vectorize path is **byte-identical**: same chunk ids, same namespaces, same `RetrieveResult`, existing tests unmodified.                                                                                                                                                                                             |
| 5     | W10, W11       | A single `RagVectorStore` conformance suite passes against Vectorize, pgvector, and DO SQLite. `NODE_CAPABILITIES.features.vectorStore.level` flips off `"unsupported"` and `packages/platform/__tests__/contracts.test.ts:45` is updated in the same commit.                                                                               |
| 6     | W12, W13       | Cost telemetry present on a non-Cloudflare provider with no AI Gateway configured. `defineRagSource` indexes an R2 bucket and re-syncs at zero embed cost.                                                                                                                                                                                  |

## 8. Risks & STOP conditions

- **STOP if W9 cannot keep the Vectorize path byte-identical.** The seam is only
  worth it if it is invisible to existing indexes; a migration for current users
  means the design is wrong, not that they need a migration guide.
- **STOP if the SQLite FTS lexical leg cannot honour a metadata filter.** A
  lexical store that fails closed under RLS is what we already have
  (`lexical-store.ts:143`); W8's entire value is composing with RLS. If
  `@lunora/search-core` cannot carry metadata predicates, re-scope to extend it
  rather than shipping a second fail-closed adapter.
- **Risk: W5/W6 add latency and cost for unproven quality gains.** Mitigate:
  phase 2's gate is a measured nDCG@10 improvement on a committed corpus, not a
  code review. Both stay opt-in and default off.
- **Risk: raising `topK` 20 → 50 (W1) raises per-query metadata transfer 2.5×.**
  Vectorize's own docs warn that `returnMetadata: "all"` queries run slower.
  Mitigate: the ceiling rises, the **default** `topK` stays 5
  (`define-rag.ts:26`).
- **Risk: pgvector-over-Hyperdrive is action-only and non-reactive** — the same
  guardrail `@lunora/hyperdrive` already documents. Mitigate: state it in the
  adapter's docs up front; RAG retrieval is already action-only
  (`packages/ai/docs/index.mdx:28`), so this costs nothing here.
- **Perf watch:** retrieval p50/p99 with and without the lexical leg, and index
  throughput with `embedMany` batching (W4). Name the bench suite when W4 lands.

## 9. Open questions (answer during execution)

1. Does `@lunora/search-core`'s analyzer/scorer carry enough to evaluate a
   metadata predicate, or does W8 need a schema extension? (Gates W8 — see the
   STOP condition.)
2. Is the 20 → 50 `topK` raise safe for **legacy V1** Vectorize indexes, or does
   the adapter need to detect index version and cap accordingly? (Gates W1.)
3. Should `embeddingModelVersion` become **required** once a `RagVectorStore`
   makes swapping stores easy? The failure it prevents gets more likely, not
   less, when the store is pluggable.
4. Does `sqlite-vec` load inside workerd's SQLite, or is W11 restricted to
   brute-force cosine? (Bounds W11's usable index size.)
5. Where does the static model price table live — `@lunora/observability`, or a
   generated artifact refreshed by a script under `scripts/`? (Gates W12.)
6. Should `defineRagSource` (W13) reuse `@lunora/replica`'s `EventsSync` for
   incremental crawl, or is a Queue-driven fan-out sufficient?
