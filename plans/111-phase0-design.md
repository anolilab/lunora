# Plan 111 — Phase 0 design: first-class RAG helper (`ctx.ai.embed` + `ctx.vectors`)

> **Spike outcome (TL;DR)**: The two primitives compose **cleanly** into an
> index→retrieve helper with **no change** to `@lunora/ai` or
> `@lunora/bindings/vectors` public surfaces — so **no STOP**. Recommended shape:
> a `defineRag(config)` helper shipped as an **`@lunora/ai/rag` subpath** (a thin
> library, _not_ a new binding or codegen-wired `ctx.rag`), callable as
> `defineRag({...})(ctx).{index,retrieve}`. It respects the Vectorize `topK`
> ceilings and the namespace/metadata constraints, and its `retrieve` return shape
> is designed for the plan-113 agent memory step to consume directly.
>
> Prototype: `plans/proto/rag/rag.ts` (+ passing test over the **real**
> `createVectors`). Ran green in-sandbox.

---

## 1. The two primitives, precisely (what the helper composes)

### 1.1 Embedding — from `@lunora/ai`

`ctx.ai` (`LunoraAi`, `packages/ai/src/types.ts:83-98`) exposes:

```ts
model: (model?: ModelInput) => LanguageModel;
embeddingModel: (model?: EmbeddingModelInput) => EmbeddingModel; // string id → Workers AI; object → passthrough
run: (model, inputs, options?) => Promise<unknown>;
workersai: WorkersAiProviderLike;
```

**`ctx.ai` does NOT expose `embed` itself.** The actual embedding call is the AI
SDK `embed`, **re-exported** from `@lunora/ai` (`packages/ai/src/index.ts:8`):

```ts
import { embed } from "@lunora/ai";
const { embedding } = await embed({ model: ctx.ai.embeddingModel("@cf/baai/bge-base-en-v1.5"), value: text });
// embedding: number[]
```

So the helper's embed seam is a **one-liner adapter**:

```ts
const embed = async (text: string): Promise<number[]> => (await aiEmbed({ model: ctx.ai.embeddingModel(cfg.embeddingModel), value: text })).embedding;
```

The embedding model is **provider-agnostic**: a string id resolves against Workers
AI; an AI SDK `EmbeddingModel` (OpenAI, etc.) passes through (create-ai.ts:77-93).

### 1.2 Vectorize — from `@lunora/bindings/vectors`

`LunoraVectors` (`packages/bindings/src/vectors/types.ts:98-105`) — the helper only
needs `upsertMany` (write) and `query` (read):

```ts
upsert     (indexName, { id, input, embed, metadata?, namespace? })      → VectorizeUpsertMutation
upsertMany (indexName, ReadonlyArray<UpsertInput>)                       → VectorizeUpsertMutation   // ≤1000/batch
query      (indexName, { input?, vector?, embed?, topK?, filter?,
                         namespace?, returnMetadata?, returnValues? })   → VectorizeMatches
```

Crucially, `upsert`/`query` take the **`embed` function directly** on their input
(`toVector` calls `input.embed(input.input)`, create-vectors.ts:25-33; `query`
calls `input.embed(input.input)`, :107-111). The helper passes its §1.1 adapter
straight into that slot — the two facades were **built to compose**.

### 1.3 Constraints the helper MUST respect

- **`topK` ceilings** (create-vectors.ts:37-96): `topK ∈ [1,100]`, lowered to
  `[1,20]` when `returnValues: true` **or** `returnMetadata: "all"`. Violations
  throw `RangeError` locally. Because the helper reads chunk text back from
  metadata (§3.3), it queries with `returnMetadata: "all"` → **it must cap `topK`
  at 20**.
- **`upsertMany` batch ≤ 1000** and embedder fan-out is internally bounded to 8
  (`UPSERT_EMBED_CONCURRENCY`, create-vectors.ts:67-81) — the helper must split
  documents that chunk to >1000 pieces.
- **Namespace = the tenant key.** Vectorize indexes are **account-global**
  (`packages/bindings/src/vectors/context.ts:213-223`): a namespace-less upsert in
  a multi-tenant/sharded app leaks vectors (ids/scores + metadata) cross-tenant.
  The helper **must** thread `namespace` on **both** write and query. (The shipped
  schema-driven sync hook emits a one-time dev warning on namespace-less sync; the
  RAG helper should do the same or require an explicit `allowSharedNamespace`.)
- **Metadata default `"indexed"`, not `"all"`** in the context bridge
  (context.ts:99-104) so queries don't leak arbitrary stored fields — but the RAG
  helper deliberately opts into `"all"` to retrieve chunk text (a documented
  tradeoff; §3.3 discusses the DO-table alternative).

---

## 2. Placement recommendation: `@lunora/ai/rag` subpath, `defineRag`

The plan lists three candidates. Assessment against the "scale invisibly" north
star, the existing ctx-facade pattern, and the "keep it a thin composition"
maintenance note:

| Option                                           | Verdict                                                                                                                                                                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) new `@lunora/rag` package**                | Overweight. RAG adds **no** new binding, no runtime elasticity — it is pure glue over two facades. A package + release + `pnpm-workspace` override is disproportionate.                                                    |
| **(c) `defineRag(...)` codegen-wired `ctx.rag`** | Premature. Wiring `ctx.rag` via codegen (like `defineSchema`/`defineFlags`) adds discovery + `_generated/*` surface for something that is a library call. Reserve as an _upgrade path_ if boilerplate proves painful (§6). |
| **(b) `@lunora/ai/rag` subpath, `defineRag`** ✅ | **Recommended.** Lives next to `ctx.ai` (where embedding lives), ships in the package a RAG app already installs, adds no binding/codegen, stays a thin composition. `sideEffects:false` subpath keeps it tree-shakeable.  |

**Why not a new `ctx.*` facade at all initially**: `ctx.ai` and `ctx.vectors` are
_invisible_ bindings. RAG is a _pattern_ over them, not a new capability of the
runtime. The north star favors not minting user-facing runtime surface unless it
removes real complexity that a library cannot. `defineRag` removes the complexity
(chunk→embed→upsert / embed→query→assemble) **as a library**, keeping the runtime
surface unchanged. If real-world boilerplate (threading `ctx` + the embed adapter)
proves annoying, graduate to `ctx.rag` in a follow-up — the API below is
forward-compatible with that.

---

## 3. The API

### 3.1 Declaration + binding

```ts
// lunora/rag.ts
import { defineRag } from "@lunora/ai/rag";

export const docs = defineRag({
    index: "docs", // a ctx.vectors index binding key
    embeddingModel: "@cf/baai/bge-base-en-v1.5", // declared ONCE → index + retrieve embed identically
    chunkSize: 1000, // built-in fixed-window chunker (chars)
    chunkOverlap: 200,
    // chunk: (text) => string[]                     // optional override (token/sentence/semantic)
    topK: 5, // default retrieval depth
});
```

`defineRag(config)` returns a **per-request factory** `(ctx) => { index, retrieve }`.
Binding `ctx` once reads well because both facades live on it:

```ts
// inside a mutation (write) or action/query (read):
await docs(ctx).index({ id: doc._id, text: doc.body, metadata: { title: doc.title }, namespace: ctx.shardKey });
const { context, chunks, sources } = await docs(ctx).retrieve(question, { topK: 5, namespace: ctx.shardKey });
```

In the real package, `ctx` supplies both `ctx.ai` and `ctx.vectors`; `defineRag`
builds the §1.1 embed adapter internally. (The prototype's `RagCtx` passes the
`embed` adapter explicitly to stay AI-SDK-free; the doc shows the real wiring.)

### 3.2 Write side — `index({ id, text, metadata?, namespace? })`

1. **Chunk** `text` via the built-in fixed-window splitter (default 1000 chars,
   200 overlap) or the `chunk` override.
2. **Embed + upsert** each chunk via `ctx.vectors.upsertMany(index, inputs)` — one
   `embed` call per chunk (fan-out bounded to 8 internally).
3. **Metadata schema linking chunk → source** (the helper owns these keys):
    - vector `id` = `` `${sourceId}#${chunkIndex}` `` (deterministic).
    - `metadata.__ragSource = sourceId`, `metadata.__ragChunk = chunkIndex`,
      `metadata.__ragText = chunkText`, plus the caller's `metadata` spread in.
    - `namespace` threaded through for tenant isolation.

Returns `{ chunks: number }`.

### 3.3 Read side — `retrieve(query, { topK?, filter?, namespace? })`

1. **Embed** the query with the _same_ model (declared once → symmetric).
2. **Query** `ctx.vectors.query(index, { input: query, embed, topK, filter,
namespace, returnMetadata: "all" })` — capping `topK` at **20** (the ceiling
   when full metadata is requested).
3. **Assemble** the ranked result:

```ts
interface RetrieveResult {
    chunks: { id; sourceId; chunkIndex; text; score; metadata? }[]; // best-first
    context: string; // chunks joined under `[source:<id>#<n>]` headers — prompt-ready
    sources: { id; metadata? }[]; // deduped, best-first
}
```

The `context` string is drop-in for a prompt; `chunks` allow custom assembly;
`sources` are deduped refs. **This shape is the plan-113 contract**: an agent's
memory/retrieval step calls `docs(ctx).retrieve(userMsg)` and injects `.context`
(and cites `.sources`).

### 3.4 Storing chunk text — metadata vs DO table (design note)

The prototype stores chunk text in vector metadata and reads it back with
`returnMetadata: "all"` (topK ≤ 20, simple, self-contained). **For production the
design recommends the alternative**: store chunk text in a Lunora **DO SQLite
table** keyed by chunk id, query Vectorize with `returnMetadata: "none"` (topK ≤
**100**), then hydrate text from the DB by id. Benefits: no Vectorize metadata-size
pressure (~10 KiB/vector cap), higher `topK`, and it reuses the DO the app already
has. This is an open question (§6.3) because it introduces a table the helper must
own or the app must declare.

---

## 4. Prototype + test evidence

`plans/proto/rag/rag.ts` implements `defineRag` exactly as §3. The test
(`rag.test.ts`, **ran green**) drives it over the **real**
`@lunora/bindings/vectors` `createVectors` (imported by source path) with:

- an in-memory `VectorizeIndexLike` double (cosine similarity; honours `topK`,
  `returnMetadata`, `namespace`), and
- a deterministic token-bag embedder (similar text → similar vectors).

Asserts: index→retrieve round-trips; chunk↔source metadata survives (id shape +
user metadata preserved, internal keys stripped); ranking returns the right source;
`context` + `sources` are well-formed; **namespace scopes retrieval** (tenant
isolation); and the **real** `createVectors` throws when `topK: 50` is requested
with `returnMetadata: "all"` (ceiling enforced live). What was mocked: the actual
Workers AI embedder + a real Vectorize index (unreachable in-sandbox) — but the
**composition logic and the real ceiling/validation code path run for real**.

---

## 5. STOP-condition assessment

| STOP condition                                                                          | Triggered?                                                        | Notes                                                                                                                                                      |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can't compose without changing `@lunora/ai` / `@lunora/bindings/vectors` public surface | **No**                                                            | `upsert`/`query` already accept an `embed` fn; `ctx.ai` already yields the model. Pure composition.                                                        |
| Chunking/metadata opens a genuinely large product surface                               | **Partial → surfaced as open questions, not decided arbitrarily** | Chunking default is fixed-window + override hook; re-index/delete and text-storage location are real decisions (§6) — deliberately left to the maintainer. |

No hard STOP. One **bounded gap** worth flagging (not a blocker): `LunoraVectors`
has `deleteByIds` but no "delete by metadata filter" / "list ids by source", so
**cleanly re-indexing a changed document** (deleting its old chunks) requires
knowing the prior chunk ids. Deterministic ids + a stored chunk-count sidestep it
(delete `${id}#0..n-1`), so it needs no surface change — but a future
`vectors.deleteByFilter` would be cleaner (§6.4).

---

## 6. Open questions (maintainer decisions)

1. **Placement — subpath vs `defineRag`-wired `ctx.rag`.** _Recommendation_:
   `@lunora/ai/rag` subpath now (§2); graduate to codegen-wired `ctx.rag` only if
   boilerplate warrants — the API is forward-compatible.
2. **Default chunking strategy.** _Recommendation_: fixed-window chars (1000/200)
   as the zero-config default + a `chunk` override; leave token-aware/semantic
   chunkers to userland or a later `@lunora/ai/rag/chunkers` export.
3. **Chunk-text storage: metadata vs DO table (§3.4).** _Recommendation_: DO table
   for production (higher `topK`, no metadata bloat); who owns the table (helper
   auto-declares vs app declares) is the sub-decision.
4. **Re-index / delete-old-chunks (§5).** Deterministic-id delete now; consider a
   `vectors.deleteByFilter` follow-up in `@lunora/bindings/vectors`.
5. **Metadata schema ownership.** The helper owns `__ragSource/__ragChunk/__ragText`
   — confirm the reserved-key convention (or a nested `__lunoraRag` object) so it
   never collides with user metadata.
6. **Tool integration for agents (ties to plan 113).** Should `retrieve` also be
   exposable as an AI SDK `tool()` so an agent calls it as a function?
   _Recommendation_: yes, ship a `docs(ctx).asTool()` in the 113 timeframe; the
   `RetrieveResult` shape already fits.
7. **Reranking scope.** Out of v1. Note as a future `retrieve({ rerank })` hook.
8. **Embedding-model declaration site.** _Recommendation_: declared once on
   `defineRag({ embeddingModel })` (as designed) so index + retrieve never drift;
   allow a per-call override only for advanced cases.

---

## 7. Cross-plan note (for 113)

Design `retrieve`'s return **for the agent consumer**: `{ context, chunks, sources }`
lets an agent memory step inject `.context` and cite `.sources` with zero
reshaping. Sequence **111 before any 113 build** (the plan's maintenance note).
