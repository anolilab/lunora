import type { Tool } from "ai";

import type { EmbeddingModelInput, LunoraAi } from "../types";
import type { RagVectorStore } from "./vector-store";

/**
 * `(text) => vector` — the embedder shape `ctx.vectors` accepts on both its
 * write (`upsert`) and read (`query`) inputs. Matches `@lunora/server`'s
 * `VectorEmbedder` and `@lunora/bindings/vectors`' `EmbedFunction<string>`.
 * @experimental
 */
export type RagEmbedder = (input: string) => Promise<ReadonlyArray<number>> | ReadonlyArray<number>;

/**
 * `RagVectorMatch` is part of the experimental `@lunora/ai` API and may change without a major version bump.
 * @experimental
 */
export interface RagVectorMatch {
    id: string;
    metadata?: Record<string, unknown>;
    score: number;
}

/**
 * `RagVectorMatches` is part of the experimental `@lunora/ai` API and may change without a major version bump.
 * @experimental
 */
export interface RagVectorMatches {
    count: number;
    matches: ReadonlyArray<RagVectorMatch>;
}

/**
 * `RagVectorQueryInput` is part of the experimental `@lunora/ai` API and may change without a major version bump.
 * @experimental
 */
export interface RagVectorQueryInput {
    /** Embedder used to vectorize `input`. */
    embed?: RagEmbedder;
    filter?: Record<string, unknown>;
    /** Natural-language query text, embedded via `embed`. */
    input?: string;
    namespace?: string;

    /**
     * How much stored metadata to return on matches. The runtime honours it even
     * though `@lunora/server`'s ctx type does not declare it — the helper relies
     * on it to read chunk text back in metadata mode.
     */
    returnMetadata?: "all" | "indexed" | "none";
    topK?: number;
}

/**
 * `RagVectorRecord` is part of the experimental `@lunora/ai` API and may change without a major version bump.
 * @experimental
 */
export interface RagVectorRecord {
    id: string;
    metadata?: Record<string, unknown>;
}

/**
 * `RagVectorUpsertInput` is part of the experimental `@lunora/ai` API and may change without a major version bump.
 * @experimental
 */
export interface RagVectorUpsertInput {
    /** Embedder used to vectorize `input`. Optional — omitted for text-search indexes. */
    embed?: RagEmbedder;
    id: string;
    input: string;
    metadata?: Record<string, unknown>;
    namespace?: string;
}

/**
 * Structural subset of the vector surface the RAG helper needs. Both the
 * `ctx.vectors` facade on Mutation/Action ctx (`@lunora/server`'s
 * `VectorSearch`) and the raw `@lunora/bindings/vectors` `LunoraVectors`
 * satisfy it — declared here so `@lunora/ai` depends on neither package.
 * @experimental
 */
export interface RagVectors {
    deleteByIds: (indexName: string, ids: ReadonlyArray<string>, namespace?: string) => Promise<unknown>;
    getByIds: (indexName: string, ids: ReadonlyArray<string>, namespace?: string) => Promise<ReadonlyArray<RagVectorRecord>>;
    query: (indexName: string, input: RagVectorQueryInput) => Promise<RagVectorMatches>;
    upsert: (indexName: string, input: RagVectorUpsertInput) => Promise<unknown>;
}

/**
 * The two facades `defineRag` binds. An `ActionCtx` satisfies this directly
 * (`ctx.ai` is action-only, so RAG methods run inside actions); any object
 * carrying the two facades works in tests.
 * @experimental
 */
export interface RagContext {
    /**
     * Resolves a Workers AI embedding-model id (or the omitted default) — an
     * `ActionCtx`'s `ctx.ai` satisfies it. OPTIONAL: when
     * {@link RagConfig.embeddingModel} is a direct AI SDK `EmbeddingModel` object
     * (bring-your-own embeddings, e.g. `@ai-sdk/openai`), the helper uses that
     * object as-is and never reads `ai`, so a hand-built context may omit it and
     * no `env.AI` binding is needed. A model-id string (or an omitted model) with
     * no `ai` present throws a directed error.
     */
    ai?: Pick<LunoraAi, "embeddingModel">;

    /**
     * The verified retrieval identity, read by {@link RagConfig.rlsFilter} to
     * derive a per-request row filter. An `ActionCtx` carrying `ctx.auth`
     * satisfies this structurally, so `docs(ctx)` picks the identity up
     * automatically; tests pass any value. `unknown` on purpose — `@lunora/ai`
     * stays decoupled from `@lunora/server`'s identity type; `rlsFilter` narrows.
     */
    auth?: unknown;

    /**
     * Optional conversation / session id. When set (and `trace` is present), each
     * embedding-model span additionally carries `gen_ai.conversation.id`, so a
     * RAG embed done inside a multi-turn conversation groups with that
     * conversation's other generation spans in the trace store. Omitted → the
     * attribute is absent (backward-compatible).
     */
    conversationId?: string;

    /**
     * Optional `ctx.trace` span factory — an `ActionCtx`'s `ctx.trace` satisfies
     * it structurally. When present, `defineRag` wraps each embedding-model
     * call in a `generation` span carrying `gen_ai.operation.name: "embeddings"`
     * and `gen_ai.request.model` up front, plus — attached post-hoc through the
     * span handle the tracer hands the body — `gen_ai.usage.input_tokens` (from
     * the embed result's token usage) and `gen_ai.usage.cost` (probed from the
     * embed result's provider metadata, e.g. AI Gateway) when those are present.
     * So the embed shows up on the trace waterfall with its usage like any other
     * instrumented model call. `unknown` on purpose — the same decoupling
     * rationale as `auth`: `defineRag` narrows it to a callable and runs embeds
     * untraced when it is absent (a hand-built context / test).
     */
    trace?: unknown;

    /**
     * The Vectorize facade backing the default store — an `ActionCtx`'s
     * `ctx.vectors` satisfies it.
     *
     * OPTIONAL, because it is never read when {@link RagConfig.store} is set,
     * and codegen only emits `ctx.vectors` for a schema that declares a vector
     * index. Requiring it made "the store that needs no Vectorize" impossible
     * to type-check in an app with no Vectorize index. Absent with no `store`
     * configured throws a directed error when the RAG is bound.
     */
    vectors?: RagVectors;
}

/**
 * Pluggable chunk-text storage. By default chunk text is stored in vector
 * metadata (`__ragText`), which forces `returnMetadata: "all"` on retrieval and
 * caps `topK` at 50 (the Vectorize full-metadata ceiling) — and each vector's
 * metadata must stay under the ~10 KiB Vectorize cap. Supplying a text store
 * (a DO table, KV, …) moves the text out of metadata: retrieval queries with
 * `returnMetadata: "indexed"` (topK up to 100) and hydrates text by chunk id.
 * @experimental
 */
export interface RagTextStore {
    /** Fetch chunk texts by id, aligned with the input order; `undefined` for misses. */
    getMany: (ids: ReadonlyArray<string>, options: { namespace?: string }) => Promise<ReadonlyArray<string | undefined>>;
    /** Persist chunk texts. Must be idempotent by chunk `id` (re-index re-puts). */
    put: (chunks: ReadonlyArray<StoredRagChunk>, options: { namespace?: string }) => Promise<void>;
    /** Optional cleanup hook, invoked when a source's chunks are deleted. */
    remove?: (ids: ReadonlyArray<string>, options: { namespace?: string }) => Promise<void>;
}

/**
 * A chunk handed to {@link RagTextStore.put} / {@link RagLexicalStore.index}.
 * @experimental
 */
export interface StoredRagChunk {
    chunkIndex: number;
    id: string;

    /**
     * The caller `metadata` attached to this chunk's source at index time
     * (internal `__rag*` keys excluded).
     *
     * Present so a {@link RagLexicalStore} can evaluate the same metadata
     * filter the vector leg gets. Without it a lexical store has nothing to
     * filter on and must fail closed on every filtered query — which made
     * hybrid search and metadata-based RLS mutually exclusive.
     */
    metadata?: Record<string, unknown>;
    sourceId: string;
    text: string;
}

/**
 * One lexical (BM25) hit returned by {@link RagLexicalStore.search}.
 * @experimental
 */
export interface LexicalMatch {
    /** The chunk vector id — the same id scheme the vector leg uses, so RRF can fuse the two. */
    id: string;
    /** BM25 relevance score (higher = better). Used only for the leg's internal ranking; RRF fuses by rank. */
    score: number;
    /** The chunk text, returned so a fused lexical-only hit needs no extra hydration round-trip. */
    text: string;
}

/**
 * Pluggable lexical (BM25 / keyword) store — the production seam for hybrid
 * retrieval. When {@link RagConfig.lexicalStore} is set, `index()` mirrors each
 * chunk's text here and `retrieve()` fuses this store's keyword ranking with the
 * vector store's semantic ranking via Reciprocal Rank Fusion. Mirrors the
 * {@link RagTextStore} shape (idempotent by chunk `id`, namespace-partitioned).
 *
 * `@lunora/ai/rag` ships `bm25LexicalStore()`, an in-memory reference adapter;
 * production deployments plug a durable one (DO SQLite inverted index, D1,
 * Vectorize-adjacent search service, …) behind this same interface.
 * @experimental
 */
export interface RagLexicalStore {
    /** Index chunk texts for keyword search. Must be idempotent by chunk `id` (re-index re-puts). */
    index: (chunks: ReadonlyArray<StoredRagChunk>, options: { namespace?: string }) => Promise<void>;
    /** Optional cleanup hook, invoked when a source's chunks are deleted or a re-index shrinks it. */
    remove?: (ids: ReadonlyArray<string>, options: { namespace?: string }) => Promise<void>;

    /**
     * Rank chunks by lexical relevance to `query`. `filter` carries the same
     * (RLS-merged) metadata predicate handed to the vector leg — a store that
     * indexes metadata MUST honour it so hybrid retrieval can't surface a row
     * the RLS filter would exclude; a namespace-only store (the reference
     * adapter) isolates by `namespace` and documents that it ignores `filter`.
     */
    search: (query: string, options: { filter?: Record<string, unknown>; namespace?: string; topK: number }) => Promise<ReadonlyArray<LexicalMatch>>;
}

/**
 * A pre-defined, reusable filter expression. Declared on `RagConfig.filters`
 * (keyed by name) and referenced by name from `RetrieveOptions.filter` — avoids
 * repeating the same tenant/RBAC filter shape across every retrieval site.
 * @example
 * ```ts
 * const docs = defineRag({
 *   index: "docs",
 *   filters: {
 *     published: { filter: { status: "published", deleted: false }, description: "Only published content" },
 *   },
 * });
 * // Later — reference by name:
 * docs(ctx).retrieve("query", { filter: "published" });
 * ```
 * @experimental
 */
export interface RagNamedFilter {
    /** Optional human-readable description for observability / Studio display. */
    description?: string;
    /** The filter expression passed verbatim to Vectorize's `filter` parameter. */
    filter: Record<string, unknown>;
}

/**
 * Re-score retrieved candidates against the query. Returns the chunks in their
 * new order; may drop chunks. See {@link RagConfig.rerank}.
 * @experimental
 */
export type RagReranker = (query: string, chunks: ReadonlyArray<RetrievedChunk>) => Promise<ReadonlyArray<RetrievedChunk>> | ReadonlyArray<RetrievedChunk>;

/**
 * Rewrite a query, or expand it into several. See {@link RagConfig.transformQuery}.
 * @experimental
 */
export type RagQueryTransform = (
    query: string,
    info: { conversationId?: string; namespace?: string },
) => Promise<ReadonlyArray<string> | string> | ReadonlyArray<string> | string;

/**
 * `RagConfig` is part of the experimental `@lunora/ai` API and may change without a major version bump.
 * @experimental
 */
export interface RagConfig {
    /**
     * Suppress the one-time dev warning emitted when `index`/`retrieve` run
     * without a `namespace`. Only appropriate for genuinely single-tenant apps —
     * Vectorize indexes are account-global, so a namespace-less index shares
     * vectors across every tenant.
     */
    allowSharedNamespace?: boolean;

    /**
     * Retain up to this many embeddings per bound context, keyed by text, so a
     * repeated `retrieve()` of the same question does not re-embed it.
     *
     * Default 0 (retain nothing beyond one call). Indexing always batches its
     * embeds regardless of this setting — the batch lives in its own
     * request-scoped map, released when `index()` returns, so it neither needs
     * this budget nor evicts what is held in it.
     *
     * Sized in entries, not bytes, but budget in bytes: one 1536-dimension
     * embedding is ~12 KB, so 100 entries is over a megabyte held in the
     * isolate. Keep it small.
     */
    cacheEmbeddings?: number;

    /**
     * How many chunks each retrieval leg fetches **before** fusion and
     * reranking trim the result to `topK`.
     *
     * Defaults to `topK * 4` whenever anything downstream reorders — a
     * `lexicalStore`, a multi-query `transformQuery`, or a `rerank` — and to
     * plain `topK` otherwise. Bounded by the store ceiling (50 in metadata
     * mode, 100 with a `textStore`).
     *
     * This is the knob that decides how much recall the reordering has to work
     * with. Fetching only `topK` per leg defeats the point of having two: the
     * whole reason to run a lexical leg is to surface a chunk the vector leg
     * ranked *below* `topK`, and it cannot do that if it was never asked for
     * more than `topK`.
     */
    candidates?: number;
    /** Custom chunker; overrides the built-in fixed-window splitter. */
    chunk?: (text: string) => ReadonlyArray<string>;
    /** Overlap (chars) between adjacent chunks. Default 200. Must be < `chunkSize`. */
    chunkOverlap?: number;

    /** Target chunk size (chars). Default 1000. */
    chunkSize?: number;

    /**
     * Embedding model, declared once so index + retrieve embed identically: a
     * Workers AI id (e.g. `@cf/baai/bge-base-en-v1.5`) or any AI SDK
     * `EmbeddingModel`.
     *
     * Omitting it resolves through `ai.embeddingModel(undefined)`, which falls
     * back to `createAi`'s `defaultEmbeddingModel` — NOT `defaultModel`, which
     * this said before and which would be a language-model id in an
     * embedding-model slot. On the generated `ctx.ai` that default comes from
     * `LUNORA_AI_DEFAULT_EMBEDDING_MODEL` in the Worker env; with neither set,
     * the first index/retrieve throws.
     */
    embeddingModel?: EmbeddingModelInput;

    /**
     * Embedding-model version tag — an opt-in discriminator that partitions the
     * vector space so a model swap can never silently return garbage. Vectors
     * embedded by one model live in a different space from another's, and
     * querying across the two returns meaningless neighbours. When set, the tag
     * is folded into the effective Vectorize namespace (and chunk-id prefix) of
     * every index/retrieve/remove, so bumping it re-partitions cleanly: old
     * vectors become unreachable to new queries (empty ≫ wrong) until sources
     * are re-indexed under the new tag.
     *
     * Set + bump this whenever you change {@link RagConfig.embeddingModel} (or
     * its dimensions). Opt-in and non-breaking — omitting it keeps the exact
     * chunk-id/namespace scheme of un-versioned indexes. Must match
     * `^[A-Za-z0-9._-]{1,40}$` (e.g. `"bge-v1.5"`, `"v2"`).
     */
    embeddingModelVersion?: string;

    /**
     * Pre-defined named filter expressions. Each key is a filter name users
     * pass through `RetrieveOptions.filter`. Throws at retrieve-time if the
     * name is not found here — catches spelling mistakes early.
     */
    filters?: Record<string, RagNamedFilter>;

    /** The Vectorize index name (a `ctx.vectors` index binding key). */
    index: string;

    /**
     * Pluggable lexical (BM25) store for hybrid retrieval. When set, `index()`
     * mirrors chunk text into it and `retrieve()` fuses the vector (semantic)
     * and lexical (keyword) rankings via Reciprocal Rank Fusion — recovering the
     * exact-term / rare-token matches a pure-embedding search misses. Use the
     * shipped `bm25LexicalStore()` reference adapter or plug your own durable
     * one. See {@link RagLexicalStore}.
     */
    lexicalStore?: RagLexicalStore;

    /** Retrieval depth for the lexical leg of hybrid search. Defaults to the effective `topK`. */
    lexicalTopK?: number;

    /**
     * Ceiling on the embedding model's dimensionality, checked once per bound
     * context against the first embedding actually produced. Defaults to
     * **1536** — Vectorize's per-vector limit at 32-bit precision.
     *
     * The default rules out most current large embedding models
     * (`text-embedding-3-large` and Gemini embedding at 3072,
     * Qwen3-Embedding at 4096). Without the check they fail at Vectorize with
     * nothing naming the cause; with it they fail at the first embed, naming
     * the ceiling and both escapes — truncate via the provider's Matryoshka
     * `dimensions` option, or set this to `false` when the index is not
     * Vectorize-backed.
     *
     * `false` disables the check entirely: the right setting for a
     * {@link RagVectors} implementation with a different (or no) ceiling.
     */
    maxEmbeddingDimensions?: number | false;

    /**
     * Enforce tenant isolation: throw (instead of the one-time dev warning)
     * when `index`/`retrieve`/`remove` run without a `namespace`. Recommended
     * for every multi-tenant app — Vectorize indexes are account-global, and
     * in metadata mode the leaked payload includes raw chunk text.
     */
    requireNamespace?: boolean;

    /**
     * Re-score the retrieved candidates against the query before they are
     * trimmed to `topK`. **Injected, not bundled** — a reranker is a model call,
     * and `@lunora/ai` takes no provider dependency to make one. Adapt yours
     * with `scoreReranker`/`batchReranker`, or write the two-line hook yourself.
     *
     * This is the standard quality step that vector search alone cannot do:
     * an embedding is computed without the query, so it cannot know which of
     * two topically-similar passages actually answers *this* question. A
     * cross-encoder sees both at once and orders them accordingly.
     *
     * Retrieval fetches {@link RagConfig.candidates} chunks, hands them
     * here, and keeps the first `topK` of whatever comes back — so the hook may
     * reorder and drop, but its output order is final. Runs after hybrid fusion
     * and before `chunkContext` expansion.
     */
    rerank?: RagReranker;

    /**
     * Row-level-security filter derived from the retrieval identity. Called once
     * per `retrieve()` with {@link RagContext.auth} (the bound ctx's `auth`); the
     * returned Vectorize metadata filter is merged over the caller's `filter`
     * with **RLS keys winning** (a caller can never widen past what RLS allows),
     * then applied to both the vector and the lexical legs. Return `undefined` to
     * add no constraint (e.g. an admin identity). Runs on retrieval only —
     * indexing is a trusted server path.
     * @example
     * ```ts
     * const docs = defineRag({
     *   index: "docs",
     *   // only ever return the caller's own org, whatever else they ask for:
     *   rlsFilter: (auth) => ({ orgId: (auth as { orgId: string }).orgId }),
     * });
     * ```
     */
    rlsFilter?: (auth: unknown) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;

    /**
     * Back this RAG with a different vector store.
     *
     * Called once per bound context with that context, so a store needing
     * per-request state (a Hyperdrive/pgvector connection from `ctx.sql`, a
     * shard's own SQLite) can build itself from it. Defaults to wrapping
     * `context.vectors` as a Vectorize-backed store.
     *
     * The store declares its own limits, and `defineRag` reads them instead of
     * assuming Vectorize's — so a pgvector index is not held to a
     * 1536-dimension ceiling or a 10 KiB metadata budget it does not have.
     */
    store?: (context: RagContext) => RagVectorStore;

    /** Chunk-text storage override — see {@link RagTextStore}. */
    textStore?: RagTextStore;

    /** Default retrieval depth. Default 5. Capped by the store: 50 (metadata mode) / 100 (text-store mode) on Vectorize. */
    topK?: number;

    /**
     * Rewrite or expand the query before it is embedded.
     *
     * The raw user query is often the worst possible search string: a
     * conversational follow-up ("what about the other one?") carries its
     * meaning in the preceding turns, and a short question shares few terms
     * with the long passage that answers it.
     *
     * Return **one** string to rewrite, or **several** to run multi-query
     * retrieval — each is embedded and searched independently and the rankings
     * are fused with RRF, which recovers passages any single phrasing would
     * miss. Returning the query unchanged is a no-op.
     *
     * **Injected, not bundled**, for the same reason as {@link RagConfig.rerank}:
     * every useful strategy (HyDE, multi-query expansion, follow-up rewriting)
     * needs a language model, and this package does not pick one for you. The
     * lexical leg searches the first returned query.
     */
    transformQuery?: RagQueryTransform;
}

/**
 * `IndexInput` is part of the experimental `@lunora/ai` API and may change without a major version bump.
 * @experimental
 */
export interface IndexInput {
    /**
     * When `false`, throws if the source text produces zero chunks (e.g. empty
     * or whitespace-only text). Default `true` (silently produces zero chunks).
     */
    allowEmptySources?: boolean;

    /** Source document id — chunk ids derive from it as `${id}#${chunkIndex}`. */
    id: string;

    /**
     * Relative weight in `[0, 1]` multiplied into this source's match scores at
     * retrieval time (default 1). Lets canonical docs outrank incidental ones.
     */
    importance?: number;
    /** Source metadata copied onto every chunk vector (e.g. title, url). */
    metadata?: Record<string, unknown>;
    /** Tenant/shard key. Required for multi-tenant apps — Vectorize is account-global. */
    namespace?: string;

    /**
     * Called after each chunk is successfully upserted. Useful for progress
     * tracking during large indexing operations — e.g. updating a UI progress
     * bar or logging per-chunk status.
     */
    onChunk?: (info: { chunkIndex: number; id: string; text: string; total: number }) => void;

    /**
     * Index this source even when its identity hash (`text` + `metadata` +
     * `importance`) is unchanged.
     *
     * The hash short-circuit skips chunking, embedding and every write — which
     * is what makes a cron re-sync cheap, and also what makes attaching a
     * `textStore` or `lexicalStore` to an ALREADY-indexed corpus a silent no-op:
     * the new store is never written, so the keyword leg returns nothing
     * forever with no error. Set this for the one pass that backfills it.
     *
     * It re-embeds, so it is not a setting to leave on.
     */
    reindex?: boolean;
    /** The document body to chunk + embed + upsert. */
    text: string;
}

/**
 * `IndexResult` is part of the experimental `@lunora/ai` API and may change without a major version bump.
 * @experimental
 */
export interface IndexResult {
    /** Number of chunks the source is indexed into. */
    chunks: number;
    /** The deterministic chunk vector ids, in chunk order. */
    ids: ReadonlyArray<string>;

    /**
     * True when the source's identity hash — its `text`, `metadata` and
     * `importance` together — matched the previously indexed one, so
     * chunking/embedding/upserts were skipped entirely (a no-op re-sync).
     * Changing `metadata` alone (a tenant move, an ACL correction) therefore
     * re-indexes: the old values are what `rlsFilter` scopes retrieval on.
     */
    unchanged: boolean;
}

/**
 * `RemoveInput` is part of the experimental `@lunora/ai` API and may change without a major version bump.
 * @experimental
 */
export interface RemoveInput {
    /** The source document id whose chunks are removed. */
    id: string;
    namespace?: string;
}

/**
 * `RetrieveOptions` is part of the experimental `@lunora/ai` API and may change without a major version bump.
 * @experimental
 */
export interface RetrieveOptions {
    /**
     * Also return this many neighbouring chunks around each match (fetched by
     * deterministic id, not re-queried) — "embed small, retrieve big". Neighbour
     * text is stitched into the chunk's `text` in document order. Best combined
     * with `chunkOverlap: 0`, since overlapping windows repeat boundary text.
     */
    chunkContext?: { after?: number; before?: number };

    /**
     * Vectorize filter expression — or the name of a pre-defined filter declared
     * in `RagConfig.filters`. Passing a name that is not registered throws at
     * call time, catching spelling mistakes early.
     */
    filter?: Record<string, unknown> | string;
    /** Drop matches whose (importance-adjusted) score falls below this threshold. */
    minScore?: number;
    namespace?: string;

    /**
     * Fires after retrieval completes, before chunk expansion. Useful for
     * observability — logging query latency, hit counts, etc.
     */
    onRetrieve?: (info: { matches: number; query: string }) => void;

    /**
     * Set `false` to skip {@link RagConfig.rerank} for this call — the escape
     * hatch for a latency-sensitive path (typeahead, an agent's inner loop)
     * that cannot afford the extra model round-trip.
     */
    rerank?: false;
    topK?: number;

    /** Set `false` to skip {@link RagConfig.transformQuery} for this call. */
    transformQuery?: false;
}

/**
 * `RetrievedChunk` is part of the experimental `@lunora/ai` API and may change without a major version bump.
 * @experimental
 */
export interface RetrievedChunk {
    chunkIndex: number;
    id: string;

    /**
     * The source-level importance weight that was multiplied into this chunk's
     * score. `1` when no importance was set at index time.
     */
    importance: number;
    /** Caller metadata stored on the vector (internal `__rag*` keys stripped). */
    metadata?: Record<string, unknown>;
    /** Cosine similarity, multiplied by the source's `importance` when one was set. */
    score: number;
    sourceId: string;
    text: string;
}

/**
 * `RagSource` is part of the experimental `@lunora/ai` API and may change without a major version bump.
 * @experimental
 */
export interface RagSource {
    id: string;
    /** Caller metadata from the source's first-seen chunk (internal keys stripped). */
    metadata?: Record<string, unknown>;

    /**
     * The source's importance weight (the `importance` value passed at index
     * time, default 1), propagated so downstream consumers can factor it into
     * their own ranking or UI.
     */
    weight?: number;
}

/**
 * The retrieve return shape — designed so an agent memory step consumes it directly.
 * @experimental
 */
export interface RetrieveResult {
    /** Ranked chunks (best first). */
    chunks: ReadonlyArray<RetrievedChunk>;
    /** Ready-to-inject prompt context: chunks joined under `[source:<id>#<n>]` headers. */
    context: string;
    /** Deduped source references, in first-seen (best) order. */
    sources: ReadonlyArray<RagSource>;
}

/**
 * `RagToolOptions` is part of the experimental `@lunora/ai` API and may change without a major version bump.
 * @experimental
 */
export interface RagToolOptions {
    /** Tool description shown to the model. Defaults to a search description naming the index. */
    description?: string;
    /** Namespace applied to every tool-invoked retrieval (the tenant key). */
    namespace?: string;
    /** Retrieval depth for tool-invoked retrievals. */
    topK?: number;
}

/**
 * The per-request RAG surface returned by binding a ctx: `docs(ctx)`.
 * @experimental
 */
export interface Rag {
    /**
     * Expose `retrieve` as an AI SDK tool (for `generateText`/`streamText`
     * `tools:` maps), so a model can decide to search the index itself.
     */
    asTool: (options?: RagToolOptions) => Tool<{ query: string }, RetrieveResult>;

    /**
     * Chunk + embed + upsert one source document. Re-indexing the same `id` is
     * an atomic-enough replace: unchanged content short-circuits via content
     * hash, and stale chunks beyond the new count are deleted automatically.
     */
    index: (input: IndexInput) => Promise<IndexResult>;
    /** Delete every chunk of a previously indexed source. */
    remove: (input: RemoveInput) => Promise<void>;
    /** Embed the query and return ranked chunks + prompt-ready context. */
    retrieve: (query: string, options?: RetrieveOptions) => Promise<RetrieveResult>;
}
