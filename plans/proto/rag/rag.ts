/**
 * Spike 111 prototype — `defineRag`: a thin RAG helper composing the two existing
 * facades (`ctx.ai` embeddings + `ctx.vectors` Vectorize) into an index -> retrieve
 * loop. No new binding, no reimplemented embedding or vector query.
 *
 * `defineRag(config)` returns a per-request factory `rag(ctx)` that binds the two
 * facades the app already has. In a real Lunora function:
 *
 * ```ts
 * // lunora/rag.ts
 * export const docs = defineRag({ index: "docs", embeddingModel: "@cf/baai/bge-base-en-v1.5" });
 *
 * // inside a mutation/action:
 * import { embed } from "@lunora/ai";
 * const r = docs({
 *   vectors: ctx.vectors,
 *   embed: async (text) => (await embed({ model: ctx.ai.embeddingModel("@cf/baai/bge-base-en-v1.5"), value: text })).embedding,
 * });
 * await r.index({ id: doc._id, text: doc.body, metadata: { title: doc.title }, namespace: ctx.shardKey });
 * const { context, chunks, sources } = await r.retrieve("how do durable objects work?", { topK: 5, namespace: ctx.shardKey });
 * ```
 *
 * The `embed` adapter is the seam to `ctx.ai`: `ctx.ai` exposes `embeddingModel(id)`
 * (a resolved AI SDK model) but not `embed` itself — that is the AI SDK `embed`
 * re-exported from `@lunora/ai`. The helper wires this adapter straight into
 * `ctx.vectors.{upsert,query}`'s `embed` slot, so `createVectors` calls it per chunk.
 */
import type { LunoraVectors } from "../../../packages/bindings/src/vectors/types";

/** The two facades the RAG helper binds — both already live on a Lunora `ctx`. */
export interface RagCtx {
    /** `(text) => vector`, adapting `ctx.ai`: `embed({ model: ctx.ai.embeddingModel(id), value: text }).embedding`. */
    embed: (text: string) => Promise<ReadonlyArray<number>>;
    /** The `@lunora/bindings/vectors` facade (`ctx.vectors`). */
    vectors: LunoraVectors;
}

export interface RagConfig {
    /** Optional custom chunker; overrides the built-in fixed-window splitter. */
    chunk?: (text: string) => ReadonlyArray<string>;
    /** Overlap (chars) between adjacent chunks. Default 200. */
    chunkOverlap?: number;
    /** Target chunk size (chars). Default 1000. */
    chunkSize?: number;
    /** Workers AI (or any AI SDK) embedding-model id, declared once so index + retrieve embed identically. */
    embeddingModel?: string;
    /** The Vectorize index name (a `ctx.vectors` binding key). */
    index: string;
    /** Default retrieval `topK`. Default 5. Capped by Vectorize (<=20 with full metadata). */
    topK?: number;
}

export interface IndexInput {
    /** Source document id — chunk ids derive from it as `${id}#${chunkIndex}`. */
    id: string;
    /** Arbitrary source metadata copied onto every chunk vector (e.g. title, url). */
    metadata?: Record<string, unknown>;
    /** Tenant/shard key. REQUIRED for multi-tenant apps — Vectorize is account-global. */
    namespace?: string;
    /** The document body to chunk + embed + upsert. */
    text: string;
}

export interface RetrieveOptions {
    filter?: Record<string, unknown>;
    namespace?: string;
    topK?: number;
}

export interface RetrievedChunk {
    chunkIndex: number;
    id: string;
    metadata?: Record<string, unknown>;
    score: number;
    sourceId: string;
    text: string;
}

/** The retrieve return shape — designed so a plan-113 agent memory step consumes it directly. */
export interface RetrieveResult {
    /** Ranked chunks (best first). */
    chunks: ReadonlyArray<RetrievedChunk>;
    /** Ready-to-inject assembled prompt context (chunks joined with source separators). */
    context: string;
    /** Deduped source references, in first-seen (best) order. */
    sources: ReadonlyArray<{ id: string; metadata?: Record<string, unknown> }>;
}

export interface Rag {
    index: (input: IndexInput) => Promise<{ chunks: number }>;
    retrieve: (query: string, options?: RetrieveOptions) => Promise<RetrieveResult>;
}

const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_CHUNK_OVERLAP = 200;
const DEFAULT_TOP_K = 5;

/**
 * Vectorize lowers the `topK` ceiling to 20 when a query asks for full metadata
 * (`returnMetadata: "all"`). This prototype stores the chunk text in metadata and
 * reads it back with `returnMetadata: "all"`, so it must honour the 20 ceiling —
 * `createVectors` enforces it and throws on a violation.
 */
const MAX_TOP_K_FULL_METADATA = 20;

/** Metadata key under which each chunk's text is stored on its vector. */
const TEXT_KEY = "__ragText";
/** Metadata key under which the owning source id is stored. */
const SOURCE_KEY = "__ragSource";
/** Metadata key under which the chunk index is stored. */
const CHUNK_INDEX_KEY = "__ragChunk";

/**
 * Built-in fixed-window chunker: split into `size`-char windows overlapping by
 * `overlap`. Deliberately simple + deterministic (a spike default); the real
 * helper takes a `chunk` override for token/sentence/semantic strategies.
 */
const fixedWindowChunks = (text: string, size: number, overlap: number): ReadonlyArray<string> => {
    const trimmed = text.trim();

    if (trimmed.length === 0) {
        return [];
    }

    if (trimmed.length <= size) {
        return [trimmed];
    }

    const step = Math.max(1, size - overlap);
    const chunks: string[] = [];

    for (let start = 0; start < trimmed.length; start += step) {
        chunks.push(trimmed.slice(start, start + size));

        if (start + size >= trimmed.length) {
            break;
        }
    }

    return chunks;
};

/**
 * Assemble ranked chunks into one prompt-ready context string, delimited by a
 * source header so the model (and a human reader) can attribute each passage.
 */
const assembleContext = (chunks: ReadonlyArray<RetrievedChunk>): string =>
    chunks.map((chunk) => `[source:${chunk.sourceId}#${String(chunk.chunkIndex)}]\n${chunk.text}`).join("\n\n");

/**
 * Declare a RAG index. Returns a factory that binds a request's `ctx` facades and
 * exposes `{ index, retrieve }`. Pure composition — no I/O until a method runs.
 */
export const defineRag = (config: RagConfig): ((ctx: RagCtx) => Rag) => {
    if (typeof config.index !== "string" || config.index.length === 0) {
        throw new TypeError("defineRag: `index` must be a non-empty Vectorize index name");
    }

    const chunkSize = config.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const chunkOverlap = config.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
    const defaultTopK = config.topK ?? DEFAULT_TOP_K;
    const splitter = config.chunk ?? ((text: string) => fixedWindowChunks(text, chunkSize, chunkOverlap));

    return (ctx: RagCtx): Rag => {
        const index = async (input: IndexInput): Promise<{ chunks: number }> => {
            const pieces = splitter(input.text);

            if (pieces.length === 0) {
                return { chunks: 0 };
            }

            // Compose the two facades: each chunk becomes an `UpsertInput` whose
            // `embed` is the ctx.ai adapter and whose metadata links chunk -> source
            // and carries the chunk text (so retrieve can reconstruct context).
            const inputs = pieces.map((piece, chunkIndex) => ({
                embed: ctx.embed,
                id: `${input.id}#${String(chunkIndex)}`,
                input: piece,
                metadata: {
                    ...input.metadata,
                    [CHUNK_INDEX_KEY]: chunkIndex,
                    [SOURCE_KEY]: input.id,
                    [TEXT_KEY]: piece,
                },
                namespace: input.namespace,
            }));

            await ctx.vectors.upsertMany(config.index, inputs);

            return { chunks: pieces.length };
        };

        const retrieve = async (query: string, options?: RetrieveOptions): Promise<RetrieveResult> => {
            const topK = Math.min(options?.topK ?? defaultTopK, MAX_TOP_K_FULL_METADATA);

            // Read side: embed the query (same adapter -> same model) and run the
            // Vectorize query, asking for full metadata so we get the chunk text back.
            const result = await ctx.vectors.query(config.index, {
                embed: ctx.embed,
                filter: options?.filter,
                input: query,
                namespace: options?.namespace,
                returnMetadata: "all",
                topK,
            });

            const chunks: RetrievedChunk[] = result.matches.map((match) => {
                const metadata = match.metadata ?? {};
                const { [CHUNK_INDEX_KEY]: rawIndex, [SOURCE_KEY]: rawSource, [TEXT_KEY]: rawText, ...userMetadata } = metadata;

                return {
                    chunkIndex: typeof rawIndex === "number" ? rawIndex : Number(rawIndex ?? 0),
                    id: match.id,
                    metadata: userMetadata,
                    score: match.score,
                    sourceId: typeof rawSource === "string" ? rawSource : String(rawSource ?? match.id),
                    text: typeof rawText === "string" ? rawText : "",
                };
            });

            const sources: { id: string; metadata?: Record<string, unknown> }[] = [];
            const seen = new Set<string>();

            for (const chunk of chunks) {
                if (!seen.has(chunk.sourceId)) {
                    seen.add(chunk.sourceId);
                    sources.push({ id: chunk.sourceId, metadata: chunk.metadata });
                }
            }

            return { chunks, context: assembleContext(chunks), sources };
        };

        return { index, retrieve };
    };
};
