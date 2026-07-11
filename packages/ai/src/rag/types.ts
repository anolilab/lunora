import type { Tool } from "ai";

import type { EmbeddingModelInput, LunoraAi } from "../types";

/**
 * `(text) => vector` — the embedder shape `ctx.vectors` accepts on both its
 * write (`upsert`) and read (`query`) inputs. Matches `@lunora/server`'s
 * `VectorEmbedder` and `@lunora/bindings/vectors`' `EmbedFunction&lt;string>`.
 */
export type RagEmbedder = (input: string) => Promise<ReadonlyArray<number>> | ReadonlyArray<number>;

export interface RagVectorMatch {
    id: string;
    metadata?: Record<string, unknown>;
    score: number;
}

export interface RagVectorMatches {
    count: number;
    matches: ReadonlyArray<RagVectorMatch>;
}

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

export interface RagVectorRecord {
    id: string;
    metadata?: Record<string, unknown>;
}

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
 */
export interface RagContext {
    ai: Pick<LunoraAi, "embeddingModel">;
    vectors: RagVectors;
}

/**
 * Pluggable chunk-text storage. By default chunk text is stored in vector
 * metadata (`__ragText`), which forces `returnMetadata: "all"` on retrieval and
 * caps `topK` at 20 (the Vectorize full-metadata ceiling) — and each vector's
 * metadata must stay under the ~10 KiB Vectorize cap. Supplying a text store
 * (a DO table, KV, …) moves the text out of metadata: retrieval queries with
 * `returnMetadata: "indexed"` (topK up to 100) and hydrates text by chunk id.
 */
export interface RagTextStore {
    /** Fetch chunk texts by id, aligned with the input order; `undefined` for misses. */
    getMany: (ids: ReadonlyArray<string>, options: { namespace?: string }) => Promise<ReadonlyArray<string | undefined>>;
    /** Persist chunk texts. Must be idempotent by chunk `id` (re-index re-puts). */
    put: (chunks: ReadonlyArray<StoredRagChunk>, options: { namespace?: string }) => Promise<void>;
    /** Optional cleanup hook, invoked when a source's chunks are deleted. */
    remove?: (ids: ReadonlyArray<string>, options: { namespace?: string }) => Promise<void>;
}

/** A chunk handed to {@link RagTextStore.put}. */
export interface StoredRagChunk {
    chunkIndex: number;
    id: string;
    sourceId: string;
    text: string;
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
 */
export interface RagNamedFilter {
    /** Optional human-readable description for observability / Studio display. */
    description?: string;
    /** The filter expression passed verbatim to Vectorize's `filter` parameter. */
    filter: Record<string, unknown>;
}

/**
 * Text-search index configuration for hybrid (vector + BM25) retrieval.
 *
 * When set, each `index()` call also upserts chunk text to the text-search
 * index, and each `retrieve()` query fuses results from both indexes via
 * Reciprocal Rank Fusion (RRF) — combining semantic (vector) and keyword
 * (BM25) relevance signals.
 */
export interface RagTextSearchConfig {
    /** The Vectorize text-search index name (a `ctx.vectors` index binding key). */
    index: string;
    /** Retrieval depth for the text-search leg. Defaults to the RAG `topK`. */
    topK?: number;
}

export interface RagConfig {
    /**
     * Suppress the one-time dev warning emitted when `index`/`retrieve` run
     * without a `namespace`. Only appropriate for genuinely single-tenant apps —
     * Vectorize indexes are account-global, so a namespace-less index shares
     * vectors across every tenant.
     */
    allowSharedNamespace?: boolean;
    /** Custom chunker; overrides the built-in fixed-window splitter. */
    chunk?: (text: string) => ReadonlyArray<string>;
    /** Overlap (chars) between adjacent chunks. Default 200. Must be < `chunkSize`. */
    chunkOverlap?: number;
    /** Target chunk size (chars). Default 1000. */
    chunkSize?: number;

    /**
     * Embedding model, declared once so index + retrieve embed identically: a
     * Workers AI id (e.g. `@cf/baai/bge-base-en-v1.5`) or any AI SDK
     * `EmbeddingModel`. Falls back to `createAi`'s `defaultModel` when omitted.
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
     * Enforce tenant isolation: throw (instead of the one-time dev warning)
     * when `index`/`retrieve`/`remove` run without a `namespace`. Recommended
     * for every multi-tenant app — Vectorize indexes are account-global, and
     * in metadata mode the leaked payload includes raw chunk text.
     */
    requireNamespace?: boolean;

    /**
     * Optional text-search index for hybrid (vector + BM25) retrieval. When
     * set, `index()` writes to both indexes and `retrieve()` fuses results
     * from both via Reciprocal Rank Fusion.
     */
    textSearch?: RagTextSearchConfig;
    /** Chunk-text storage override — see {@link RagTextStore}. */
    textStore?: RagTextStore;
    /** Default retrieval depth. Default 5. Capped at 20 (metadata mode) / 100 (text-store mode). */
    topK?: number;
}

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
    /** The document body to chunk + embed + upsert. */
    text: string;
}

export interface IndexResult {
    /** Number of chunks the source is indexed into. */
    chunks: number;
    /** The deterministic chunk vector ids, in chunk order. */
    ids: ReadonlyArray<string>;

    /**
     * True when the source's content hash matched the previously indexed hash —
     * chunking/embedding/upserts were skipped entirely (a no-op re-sync).
     */
    unchanged: boolean;
}

export interface RemoveInput {
    /** The source document id whose chunks are removed. */
    id: string;
    namespace?: string;
}

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
    topK?: number;
}

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

/** The retrieve return shape — designed so an agent memory step consumes it directly. */
export interface RetrieveResult {
    /** Ranked chunks (best first). */
    chunks: ReadonlyArray<RetrievedChunk>;
    /** Ready-to-inject prompt context: chunks joined under `[source:&lt;id>#&lt;n>]` headers. */
    context: string;
    /** Deduped source references, in first-seen (best) order. */
    sources: ReadonlyArray<RagSource>;
}

export interface RagToolOptions {
    /** Tool description shown to the model. Defaults to a search description naming the index. */
    description?: string;
    /** Namespace applied to every tool-invoked retrieval (the tenant key). */
    namespace?: string;
    /** Retrieval depth for tool-invoked retrievals. */
    topK?: number;
}

/** The per-request RAG surface returned by binding a ctx: `docs(ctx)`. */
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
